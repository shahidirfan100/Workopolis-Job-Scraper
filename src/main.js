import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const MAX_HTTP_RETRIES = 3;
const DETAIL_CONCURRENCY = 6;
const DATASET_BATCH_SIZE = 25;

const cookieJar = new CookieJar();

const HEADER_GEN_OPTIONS = {
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 132 },
        { name: 'firefox', minVersion: 120, maxVersion: 132 },
        { name: 'edge', minVersion: 120, maxVersion: 132 },
        { name: 'safari', minVersion: 16, maxVersion: 18 },
    ],
    devices: ['desktop', 'mobile'],
    locales: ['en-CA', 'en-US', 'en-GB'],
};

let sessionCounter = 0;
const sessionToken = { unique: ++sessionCounter };

const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const realisticDelay = () => {
    const base = 200 + Math.floor(Math.random() * 400);
    const extra = Math.random() < 0.15
        ? 1000 + Math.floor(Math.random() * 2000)
        : 0;
    return wait(base + extra);
};

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const parseJsonBody = (body, url) => {
    if (typeof body === 'object' && body !== null) return body;
    if (typeof body !== 'string') {
        throw new Error(`Unexpected response type from ${url}: ${typeof body}`);
    }

    const trimmed = body.trim();
    if (!trimmed) throw new Error(`Empty response body from ${url}`);

    if (
        trimmed.startsWith('<!DOCTYPE')
        || trimmed.startsWith('<html')
        || trimmed.includes('<title>Just a moment...')
        || trimmed.includes('cf-browser-verification')
    ) {
        throw new Error(`Blocked with HTML challenge instead of JSON from ${url}`);
    }

    try {
        return JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}. Preview: ${trimmed.slice(0, 160)}`);
    }
};

const cleanValue = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
    }
    if (Array.isArray(value)) {
        const cleaned = value.map(cleanValue).filter(Boolean);
        return cleaned.length ? cleaned : null;
    }
    return value;
};

const formatSalary = (salaryInfo) => {
    if (!salaryInfo || typeof salaryInfo !== 'object') return null;

    const min = Number.isFinite(Number(salaryInfo.min)) ? Number(salaryInfo.min) : null;
    const max = Number.isFinite(Number(salaryInfo.max)) ? Number(salaryInfo.max) : null;
    const intervalMap = {
        HOURLY: '/hour',
        YEARLY: '/year',
        MONTHLY: '/month',
        WEEKLY: '/week',
        DAILY: '/day',
    };
    const interval = intervalMap[salaryInfo.type] ?? '';

    if (min && max) return `$${min.toLocaleString()} - $${max.toLocaleString()}${interval}`;
    if (min) return `From $${min.toLocaleString()}${interval}`;
    if (max) return `Up to $${max.toLocaleString()}${interval}`;
    return null;
};

const normalizeDatePosted = (value) => {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
        const timestamp = Number(value);
        const date = new Date(timestamp);
        if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
        return trimmed;
    }

    return null;
};

const htmlToText = (html) => {
    if (!html || typeof html !== 'string') return null;

    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|ul|ol|br)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&rsquo;/gi, '\'')
        .replace(/&lsquo;/gi, '\'')
        .replace(/&rdquo;/gi, '"')
        .replace(/&ldquo;/gi, '"')
        .replace(/&ndash;/gi, '-')
        .replace(/&mdash;/gi, '-')
        .replace(/&bull;/gi, '-')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || null;
};

const sanitizeHtml = (html) => {
    if (!html || typeof html !== 'string') return null;

    const allowedTags = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

    const sanitized = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?([a-z0-9-]+)(?:\s[^>]*)?>/gi, (match, tagName) => {
            const normalizedTag = String(tagName).toLowerCase();
            if (!allowedTags.has(normalizedTag)) return '';
            if (match.startsWith('</')) return `</${normalizedTag}>`;
            return normalizedTag === 'br' ? '<br>' : `<${normalizedTag}>`;
        })
        .replace(/<(p|strong|b|em|i|li|ul|ol|h[1-6])>\s*<\/\1>/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return sanitized || null;
};

const escapeHtml = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildSearchUrl = ({ keyword, location, postedDate }) => {
    const url = new URL('https://www.workopolis.com/search');
    if (keyword) url.searchParams.set('q', keyword);
    if (location) url.searchParams.set('l', location);
    if (postedDate && postedDate !== 'anytime') url.searchParams.set('posted', postedDate);
    return url.href;
};

const buildNextDataUrl = ({ buildId, keyword, location, cursor }) => {
    const url = new URL(`https://www.workopolis.com/_next/data/${buildId}/search.json`);
    if (keyword) url.searchParams.set('q', keyword);
    if (location) url.searchParams.set('l', location);
    if (cursor) url.searchParams.set('cursor', cursor);
    return url.href;
};

const buildJobDetailUrl = ({ jobKey, locale, continueUrl, jobCardTrackingKey }) => {
    const url = new URL('https://www.workopolis.com/api/next/job');
    url.searchParams.set('key', jobKey);
    url.searchParams.set('locale', locale);
    url.searchParams.set('indeedApplyContinueUrl', continueUrl);
    if (jobCardTrackingKey) url.searchParams.set('jobCardTrackingKey', jobCardTrackingKey);
    return url.href;
};

const parseStartConfig = ({ startUrls, keyword, location, postedDate }) => {
    const fallback = {
        keyword,
        location,
        locale: 'en-CA',
        postedDate,
        startSearchUrl: buildSearchUrl({ keyword, location, postedDate }),
    };

    if (!Array.isArray(startUrls) || startUrls.length === 0) return fallback;

    const firstUrl = typeof startUrls[0] === 'string' ? startUrls[0] : startUrls[0]?.url;
    if (!firstUrl) return fallback;

    try {
        const parsed = new URL(firstUrl);
        return {
            keyword: parsed.searchParams.get('q') || keyword,
            location: parsed.searchParams.get('l') || location,
            locale: parsed.pathname.startsWith('/fr-CA') ? 'fr-CA' : 'en-CA',
            postedDate,
            startSearchUrl: parsed.href,
        };
    } catch {
        return fallback;
    }
};

const normalizeJobsPayload = (payload) => {
    const pageProps = payload?.pageProps || payload?.data || payload || {};
    const jobs = Array.isArray(pageProps.jobs) ? pageProps.jobs : [];
    const pageCursors = pageProps.pageCursors && typeof pageProps.pageCursors === 'object' ? pageProps.pageCursors : {};
    const currentPageNumber = Number(pageProps.currentPageNumber) || 1;
    const nextCursor = (
        cleanValue(pageProps.nextCursor)
        || cleanValue(pageCursors[String(currentPageNumber + 1)])
        || cleanValue(pageProps.nextPageUrl ? new URL(pageProps.nextPageUrl, 'https://www.workopolis.com').searchParams.get('cursor') : null)
        || null
    );

    return {
        jobs,
        viewJobData: pageProps.viewJobData || null,
        pageCursors,
        currentPageNumber,
        nextCursor,
    };
};

const parseCompany = (job, detail) => cleanValue(
    (typeof job.company === 'string' ? job.company : job.company?.name || job.company?.displayName)
    || job.companyName
    || job.employer
    || detail?.employerName,
);

const parseLocation = (job, detail) => {
    const jobLocation = typeof job.location === 'string'
        ? job.location
        : job.location?.displayName
            || [job.location?.city, job.location?.province].filter(Boolean).join(', ');

    return cleanValue(jobLocation || job.formattedLocation || detail?.formattedLocation || detail?.location);
};

const parseEmploymentType = (job, detail) => {
    const value = job.jobTypes
        || job.employmentType
        || job.jobType
        || job.type
        || detail?.jobTypes
        || detail?.employmentType;

    if (Array.isArray(value)) return cleanValue(value.join(', '));
    return cleanValue(value);
};

const parseDelimitedList = (value) => {
    if (typeof value === 'string') return cleanValue(value);
    if (!Array.isArray(value)) return null;

    const parts = value
        .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') return item.label || item.name || item.text || '';
            return '';
        })
        .filter(Boolean);

    return parts.length ? parts.join(', ') : null;
};

const buildRecord = (job, detail, context) => {
    const rawDescription = cleanValue(
        detail?.jobDescriptionHtml
        || detail?.description
        || context.viewJobData?.jobDescriptionHtml
        || context.viewJobData?.description,
    );
    const fallbackSnippet = cleanValue(job.snippet || detail?.snippet);
    const descriptionHtml = sanitizeHtml(rawDescription) || (fallbackSnippet ? `<p>${escapeHtml(fallbackSnippet)}</p>` : null);
    const descriptionText = htmlToText(rawDescription) || fallbackSnippet;

    const salary = cleanValue(
        formatSalary(job.salaryInfo)
        || job.salary
        || job.salaryText
        || job.compensation
        || detail?.salary
        || detail?.salaryText,
    );

    const record = {
        url: cleanValue(`https://www.workopolis.com/jobsearch/viewjob/${job.jobKey}`),
        jobKey: cleanValue(job.jobKey),
        title: cleanValue(job.title || job.jobTitle || detail?.title || detail?.jobTitle),
        company: parseCompany(job, detail),
        location: parseLocation(job, detail),
        salary,
        employmentType: parseEmploymentType(job, detail),
        workSettings: cleanValue(
            job.remoteAttributes?.displayValue
            || (job.remoteAttributes?.isRemote ? 'Remote' : null)
            || parseDelimitedList(detail?.workSettings),
        ),
        datePosted: normalizeDatePosted(job.dateOnIndeed || job.datePublished || job.datePosted || detail?.dateOnIndeed || detail?.datePublished),
        benefits: parseDelimitedList(job.benefits || detail?.benefits),
        snippet: cleanValue(job.snippet || detail?.snippet),
        requirements: parseDelimitedList(job.requirements || detail?.requirements || detail?.skills),
        description_html: descriptionHtml,
        description_text: descriptionText,
        _source: 'workopolis.com',
        _fetchedAt: new Date().toISOString(),
    };

    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== ''));
};

const runWithConcurrency = async (items, limit, worker) => {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = index++;
            await worker(items[current], current);
        }
    });
    await Promise.all(runners);
};

Actor.main(async () => {
    process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { reason: String(reason) }));
    process.on('uncaughtException', (error) => log.error('Uncaught exception', { message: error.message, stack: error.stack }));

    let input = await Actor.getInput() ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) input = {};

    const isLocalRun = process.env.APIFY_IS_AT_HOME !== '1';
    const shouldLoadLocalInput = isLocalRun && (
        !Object.keys(input).length
        || Object.prototype.hasOwnProperty.call(input, 'buildId')
    );

    if (shouldLoadLocalInput) {
        try {
            const raw = await readFile(path.join(process.cwd(), 'INPUT.json'), 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                input = parsed;
                log.info('Using INPUT.json for local run.');
            }
        } catch {
            log.warning('Could not read INPUT.json, falling back to Actor input.');
        }
    }

    const keyword = toTrimmedString(input.keyword);
    const location = toTrimmedString(input.location);
    const postedDate = ['anytime', '24h', '7d', '30d'].includes(input.posted_date) ? input.posted_date : 'anytime';
    const resultsWanted = Number.isFinite(Number(input.results_wanted)) ? Math.max(1, Number(input.results_wanted)) : 20;
    const maxPages = Number.isFinite(Number(input.max_pages)) ? Math.max(1, Number(input.max_pages)) : 10;

    const searchConfig = parseStartConfig({
        startUrls: input.startUrls,
        keyword,
        location,
        postedDate,
    });

    if (!searchConfig.keyword && !searchConfig.startSearchUrl) {
        throw new Error('Missing search input. Provide keyword or startUrls.');
    }

    const locationLabel = searchConfig.location ? ` in ${searchConfig.location}` : ' across Canada';
    log.info(`Scraping ${resultsWanted} "${searchConfig.keyword}" jobs${locationLabel}`);

    let proxyUrl = null;
    if (input.proxyConfiguration) {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
            proxyUrl = await proxyConfiguration?.newUrl();
        } catch (error) {
            log.warning(`Custom proxy configuration failed: ${error.message}`);
        }
    } else if (!isLocalRun) {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration({
                useApifyProxy: true,
                apifyProxyGroups: ['RESIDENTIAL'],
            });
            proxyUrl = await proxyConfiguration?.newUrl();
        } catch (error) {
            log.warning(`Default proxy initialization failed: ${error.message}`);
        }
    }

    const requestWithHeaders = async (url, { isHtml = false } = {}) => {
        for (let attempt = 1; attempt <= MAX_HTTP_RETRIES; attempt++) {
            try {
                await realisticDelay();
                const response = await gotScraping({
                    url,
                    timeout: { request: 30000 },
                    retry: { limit: 0 },
                    useHeaderGenerator: true,
                    headerGeneratorOptions: HEADER_GEN_OPTIONS,
                    sessionToken,
                    cookieJar,
                    headers: {
                        Accept: isHtml
                            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                            : 'application/json, text/plain, */*',
                    },
                    https: { rejectUnauthorized: true },
                    ...(proxyUrl ? { proxyUrl } : {}),
                });
                const body = String(response.body || '');
                if (isHtml) {
                    if (
                        body.includes('<title>Just a moment...')
                        || body.includes('cf-browser-verification')
                    ) {
                        throw new Error(`Blocked with HTML challenge from ${url}`);
                    }
                    return body;
                }
                return parseJsonBody(response.body, url);
            } catch (error) {
                const message = error.message || String(error);
                const blocked = /Blocked with HTML challenge|403|429|captcha|just a moment/i.test(message);
                log.warning(`Request failed (${attempt}/${MAX_HTTP_RETRIES}): ${message.slice(0, 80)}`);

                if (blocked && attempt === MAX_HTTP_RETRIES) throw error;
                if (attempt < MAX_HTTP_RETRIES) await wait(1000 * attempt);
            }
        }

        throw new Error(`Failed to fetch ${url}`);
    };

    const requestJson = (url) => requestWithHeaders(url, { isHtml: false });
    const requestTextHtml = (url) => requestWithHeaders(url, { isHtml: true });

    const discoverBuildId = async () => {
        const html = await requestTextHtml(searchConfig.startSearchUrl);
        const buildId = html.match(/"buildId"\s*:\s*"([^"]+)"/)?.[1]
            || html.match(/_next\/static\/([^/]+)\/_buildManifest\.js/)?.[1]
            || null;

        if (!buildId) {
            throw new Error('Could not discover Workopolis buildId for paginated listing API.');
        }

        return buildId;
    };

    const seenJobKeys = new Set();
    const savedJobKeys = new Set();
    const batchBuffer = [];
    let saveChain = Promise.resolve();
    let savedCount = 0;
    let duplicateCount = 0;
    let droppedCount = 0;
    let missingDescriptions = 0;
    let missingCompany = 0;
    let missingLocation = 0;

    const isValidRecord = (record) => Boolean(record?.jobKey && record?.title && record?.url);

    const flushBatch = async (force = false) => {
        if (!batchBuffer.length) return;
        if (!force && batchBuffer.length < DATASET_BATCH_SIZE) return;

        const batch = batchBuffer.splice(0, batchBuffer.length);
        await Dataset.pushData(batch);
        savedCount += batch.length;
        log.info(`Saved ${savedCount} jobs`);
    };

    const queueRecordForSave = async (record) => {
        saveChain = saveChain.then(async () => {
            if (!isValidRecord(record)) {
                droppedCount++;
                return;
            }

            if (savedJobKeys.has(record.jobKey)) {
                duplicateCount++;
                return;
            }

            savedJobKeys.add(record.jobKey);

            if (!record.description_text) missingDescriptions++;
            if (!record.company) missingCompany++;
            if (!record.location) missingLocation++;

            batchBuffer.push(record);
            await flushBatch(false);
        });

        return saveChain;
    };

    const buildId = await discoverBuildId();

    let cursor = null;
    let currentPage = 1;

    while (savedCount < resultsWanted && currentPage <= maxPages) {
        const pageUrl = buildNextDataUrl({
            buildId,
            keyword: searchConfig.keyword,
            location: searchConfig.location,
            cursor,
        });

        const payload = normalizeJobsPayload(await requestJson(pageUrl));
        if (!payload.jobs.length) {
            log.info(`Page ${currentPage}: empty`);
            break;
        }

        const newJobs = payload.jobs.filter((j) => j?.jobKey && !seenJobKeys.has(j.jobKey));
        const remaining = resultsWanted - savedCount;
        const jobsToTake = newJobs.slice(0, remaining);

        for (const job of jobsToTake) seenJobKeys.add(job.jobKey);

        if (!jobsToTake.length) break;

        log.info(`Page ${currentPage}: ${jobsToTake.length} jobs`);

        await runWithConcurrency(jobsToTake, DETAIL_CONCURRENCY, async (job) => {
            const viewJobData = payload.viewJobData?.jobKey === job.jobKey ? payload.viewJobData : null;
            let detail = null;

            if (!viewJobData?.jobDescriptionHtml && !viewJobData?.description) {
                const detailUrl = buildJobDetailUrl({
                    jobKey: job.jobKey,
                    locale: searchConfig.locale,
                    continueUrl: searchConfig.startSearchUrl,
                    jobCardTrackingKey: job.jobCardTrackingKey || null,
                });

                try {
                    detail = await requestJson(detailUrl);
                } catch (error) {
                    log.warning(`Detail fetch failed: ${error.message.slice(0, 80)}`);
                }
            }

            const record = buildRecord(job, detail, { viewJobData });
            await queueRecordForSave(record);
        });

        await saveChain;
        await flushBatch(true);

        if (savedCount >= resultsWanted) break;

        cursor = payload.nextCursor;
        if (!cursor) break;
        currentPage++;
    }

    if (duplicateCount > 0) {
        log.info(`Skipped ${duplicateCount} duplicate records before dataset push.`);
    }
    if (droppedCount > 0) {
        log.warning(`Dropped ${droppedCount} incomplete records missing required fields.`);
    }
    if (missingDescriptions > 0) {
        log.warning(`Records still missing description_text: ${missingDescriptions}/${savedCount}`);
    }
    if (missingCompany > 0 || missingLocation > 0) {
        log.warning(`Records with partial source data remain`, {
            missingCompany,
            missingLocation,
        });
    }

    if (!savedCount) {
        throw new Error('No valid records extracted from Workopolis.');
    }

    log.info('Run complete', {
        saved: savedCount,
        missingDescriptions,
        missingCompany,
        missingLocation,
    });
});
