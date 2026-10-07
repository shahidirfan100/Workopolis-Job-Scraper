import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

const MAX_HTTP_ATTEMPTS = 4;
const DETAIL_CONCURRENCY = 6;
const DATASET_BATCH_SIZE = 25;
const PROFILE_COOLDOWN_MS = 5 * 60 * 1000;

// Response shapes of the Workopolis Next.js payload used by this Actor. The
// listing payload is served as an embedded hydration JSON document, while the
// detail payload is served as plain JSON.
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const JSON_ACCEPT = 'application/json, text/plain, */*';

const SEARCH_BASE_URL = 'https://www.workopolis.com/search';
const JOB_DETAIL_URL = 'https://www.workopolis.com/api/next/job';

// Browser/TLS impersonation profiles verified against Workopolis. The bare
// `chrome` alias and the newest `chrome13x` profiles are intermittently
// challenged by the edge, so requests rotate across a pool of profiles that
// consistently return data and switch away from any profile that gets blocked.
const BROWSER_PROFILES = ['chrome124', 'chrome151', 'firefox', 'okhttp'];

class RecoverableRequestError extends Error {
    constructor(message, retryAfterMs = null) {
        super(message);
        this.name = 'RecoverableRequestError';
        this.retryAfterMs = retryAfterMs;
    }
}

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

const isChallengeHtml = (value) => /Just a moment|cf-browser-verification|cf-chl|Attention Required|Enable JavaScript and cookies/i.test(String(value ?? ''));

const parseRetryAfter = (value) => {
    if (!value) return null;

    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 15000);

    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 0), 15000);

    return null;
};

const isNetworkError = (error) => /connect|timed?\s?out|ECONN|socket|network|reset|fetch failed|closed/i.test(String(error?.message ?? ''));

const backoffDelay = async (attempt, retryAfterMs) => {
    const base = retryAfterMs ?? Math.min(1000 * 2 ** attempt, 8000);
    const jitter = Math.floor(Math.random() * 500);
    await wait(Math.min(base, 15000) + jitter);
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

const firstNonEmpty = (...values) => {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && !value.trim()) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        return value;
    }
    return null;
};

const SALARY_INTERVALS = {
    HOURLY: '/hour',
    YEARLY: '/year',
    MONTHLY: '/month',
    WEEKLY: '/week',
    DAILY: '/day',
};

const joinSalaryRange = (min, max, interval) => {
    if (min && max) return `$${min.toLocaleString()} - $${max.toLocaleString()}${interval}`;
    if (min) return `From $${min.toLocaleString()}${interval}`;
    if (max) return `Up to $${max.toLocaleString()}${interval}`;
    return null;
};

const formatStructuredSalary = (salary) => {
    if (!salary || typeof salary !== 'object') return null;

    // Current payload uses minor currency units, e.g. { minMinor, maxMinor, unitOfWork }.
    const minMinor = Number(salary.minMinor);
    const maxMinor = Number(salary.maxMinor);
    if (Number.isFinite(minMinor) || Number.isFinite(maxMinor)) {
        const min = Number.isFinite(minMinor) ? minMinor / 100 : null;
        const max = Number.isFinite(maxMinor) ? maxMinor / 100 : null;
        return joinSalaryRange(min, max, SALARY_INTERVALS[salary.unitOfWork] ?? '');
    }

    // Older payload variant, e.g. { min, max, type }.
    const min = Number(salary.min);
    const max = Number(salary.max);
    if (Number.isFinite(min) || Number.isFinite(max)) {
        return joinSalaryRange(
            Number.isFinite(min) ? min : null,
            Number.isFinite(max) ? max : null,
            SALARY_INTERVALS[salary.type] ?? '',
        );
    }

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

const buildSearchUrl = ({ keyword, location, postedDate, cursor }) => {
    const url = new URL(SEARCH_BASE_URL);
    if (keyword) url.searchParams.set('q', keyword);
    if (location) url.searchParams.set('l', location);
    if (postedDate && postedDate !== 'anytime') url.searchParams.set('t', postedDate);
    if (cursor) url.searchParams.set('cursor', cursor);
    return url.href;
};

const addCursorToUrl = (baseUrl, cursor) => {
    const url = new URL(baseUrl);
    if (cursor) url.searchParams.set('cursor', cursor);
    else url.searchParams.delete('cursor');
    return url.href;
};

const buildJobDetailUrl = ({ jobKey, locale, continueUrl, jobCardTrackingKey }) => {
    const url = new URL(JOB_DETAIL_URL);
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
        const urlPostedDate = parsed.searchParams.get('t');
        return {
            keyword: parsed.searchParams.get('q') || keyword,
            location: parsed.searchParams.get('l') || location,
            locale: parsed.pathname.startsWith('/fr-CA') ? 'fr-CA' : 'en-CA',
            postedDate: ['anytime', '24h', '7d', '30d'].includes(urlPostedDate) ? urlPostedDate : postedDate,
            startSearchUrl: parsed.href,
        };
    } catch {
        return fallback;
    }
};

const normalizeJobsPayload = (pageProps) => {
    const jobs = Array.isArray(pageProps.jobs) ? pageProps.jobs : [];
    const pageCursors = pageProps.pageCursors && typeof pageProps.pageCursors === 'object' ? pageProps.pageCursors : {};
    const currentPageNumber = Number(pageProps.currentPageNumber) || 1;
    const nextCursor = (
        cleanValue(pageProps.nextCursor)
        || cleanValue(pageCursors[String(currentPageNumber + 1)])
        || null
    );

    return {
        jobs,
        viewJobData: pageProps.viewJobData || null,
        pageCursors,
        currentPageNumber,
        nextCursor,
        resultCount: Number(pageProps.resultCount) || null,
    };
};

const parseCompany = (job, detail) => cleanValue(firstNonEmpty(
    typeof job.company === 'string' ? job.company : job.company?.name || job.company?.displayName,
    job.companyName,
    job.employer,
    detail?.employerName,
    detail?.company,
));

const parseLocation = (job, detail) => {
    const jobLocation = typeof job.location === 'string'
        ? job.location
        : job.location?.displayName
            || [job.location?.city, job.location?.province].filter(Boolean).join(', ');

    return cleanValue(firstNonEmpty(
        jobLocation,
        job.formattedLocation,
        detail?.formattedLocation,
        detail?.location,
    ));
};

const parseDelimitedList = (value) => {
    if (typeof value === 'string') return cleanValue(value);
    if (!Array.isArray(value)) return null;

    const parts = value
        .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') return item.label || item.name || item.text || item.displayValue || '';
            return '';
        })
        .filter(Boolean);

    return parts.length ? parts.join(', ') : null;
};

const parseEmploymentType = (job, detail) => parseDelimitedList(firstNonEmpty(
    job.jobTypes,
    job.employmentType,
    job.jobType,
    job.type,
    detail?.jobTypes,
    detail?.employmentType,
));

const parseWorkSettings = (job, detail) => cleanValue(firstNonEmpty(
    parseDelimitedList(job.remoteAttributes),
    job.remoteAttributes?.displayValue,
    job.remoteAttributes?.isRemote ? 'Remote' : null,
    parseDelimitedList(detail?.workSettings),
));

const parseSalary = (job, detail) => cleanValue(firstNonEmpty(
    typeof job.salaryInfo === 'string' ? job.salaryInfo : null,
    formatStructuredSalary(job.salaryInfo),
    job.salary,
    job.salaryText,
    job.compensation,
    formatStructuredSalary(detail?.baseSalary),
    detail?.salary,
    detail?.salaryText,
    detail?.compensation,
));

const buildRecord = (job, detail, context) => {
    const rawDescription = cleanValue(firstNonEmpty(
        detail?.jobDescriptionHtml,
        detail?.description,
        context.viewJobData?.jobDescriptionHtml,
        context.viewJobData?.description,
    ));
    const fallbackSnippet = cleanValue(firstNonEmpty(job.snippet, detail?.snippet));
    const descriptionHtml = sanitizeHtml(rawDescription) || (fallbackSnippet ? `<p>${escapeHtml(fallbackSnippet)}</p>` : null);
    const descriptionText = htmlToText(rawDescription) || fallbackSnippet;

    const record = {
        url: cleanValue(`https://www.workopolis.com/jobsearch/viewjob/${job.jobKey}`),
        jobKey: cleanValue(job.jobKey),
        title: cleanValue(firstNonEmpty(job.title, job.jobTitle, detail?.title, detail?.jobTitle, detail?.displayTitle)),
        company: parseCompany(job, detail),
        location: parseLocation(job, detail),
        salary: parseSalary(job, detail),
        employmentType: parseEmploymentType(job, detail),
        workSettings: parseWorkSettings(job, detail),
        datePosted: normalizeDatePosted(firstNonEmpty(
            job.dateOnIndeed,
            job.datePublished,
            job.datePosted,
            detail?.dateOnIndeed,
            detail?.datePublished,
        )),
        benefits: parseDelimitedList(firstNonEmpty(job.benefits, detail?.benefits)),
        snippet: fallbackSnippet,
        requirements: parseDelimitedList(firstNonEmpty(job.requirements, detail?.qualifications, detail?.requirements, detail?.skills)),
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

const parseJsonText = (text, url) => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error(`Empty response body from ${url}`);
    if (isChallengeHtml(trimmed)) throw new Error(`Blocked with HTML challenge instead of JSON from ${url}`);

    try {
        return JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}. Preview: ${trimmed.slice(0, 160)}`);
    }
};

const parseNextData = (html, url) => {
    const match = String(html ?? '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) {
        if (isChallengeHtml(html)) throw new Error(`Blocked with HTML challenge from ${url}`);
        throw new Error(`Missing page data payload from ${url}`);
    }

    try {
        return JSON.parse(match[1]);
    } catch (error) {
        throw new Error(`Invalid page data payload from ${url}: ${error.message}`);
    }
};

Actor.main(async () => {
    process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { reason: String(reason) }));
    process.on('uncaughtException', (error) => log.error('Uncaught exception', { message: error.message, stack: error.stack }));

    let input = await Actor.getInput() ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) input = {};

    const isLocalRun = process.env.APIFY_IS_AT_HOME !== '1';
    if (isLocalRun && !Object.keys(input).length) {
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
    }

    if (!proxyUrl && !isLocalRun) {
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

    // One client per profile is cached and reused so connections are pooled
    // instead of rebuilt for every request.
    const clientCache = new Map();
    let preferredProfileIndex = 0;
    const profileCooldownUntil = new Array(BROWSER_PROFILES.length).fill(0);

    const getClient = (browser) => {
        let client = clientCache.get(browser);
        if (!client) {
            client = new Impit({
                browser,
                timeout: 30000,
                ...(proxyUrl ? { proxyUrl } : {}),
            });
            clientCache.set(browser, client);
        }
        return client;
    };

    // Skip profiles that recently failed so parallel and follow-up requests do
    // not each rediscover the same block.
    const selectProfileIndex = () => {
        const { length } = BROWSER_PROFILES;
        const now = Date.now();
        for (let step = 0; step < length; step++) {
            const index = (preferredProfileIndex + step) % length;
            if (profileCooldownUntil[index] <= now) return index;
        }
        return preferredProfileIndex % length;
    };

    const requestRaw = async (url, { accept }) => {
        let lastError;

        for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
            const profileIndex = selectProfileIndex();
            const browser = BROWSER_PROFILES[profileIndex];

            try {
                await realisticDelay();
                const client = getClient(browser);
                const response = await client.fetch(url, { headers: { accept } });
                const text = String(await response.text());
                const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

                if (isChallengeHtml(text)) {
                    throw new RecoverableRequestError(`Edge challenge (HTTP ${response.status})`, retryAfterMs);
                }
                if (response.status === 429) {
                    throw new RecoverableRequestError('HTTP 429 rate limited', retryAfterMs);
                }
                if (response.status === 403) {
                    throw new RecoverableRequestError('HTTP 403 forbidden', retryAfterMs);
                }
                if (response.status >= 500) {
                    throw new RecoverableRequestError(`HTTP ${response.status} server error`, retryAfterMs);
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 160)}`);
                }

                // Lock in the profile that worked so later requests start from it.
                preferredProfileIndex = profileIndex;
                return { text, status: response.status };
            } catch (error) {
                lastError = error;
                const recoverable = error instanceof RecoverableRequestError || isNetworkError(error);
                log.warning(`Request attempt ${attempt + 1}/${MAX_HTTP_ATTEMPTS} failed [${browser}]: ${String(error.message).slice(0, 120)}`);
                if (!recoverable) throw error;

                // Cool down the failed profile and move past it for the next attempt.
                profileCooldownUntil[profileIndex] = Date.now() + PROFILE_COOLDOWN_MS;
                preferredProfileIndex = (profileIndex + 1) % BROWSER_PROFILES.length;

                if (attempt < MAX_HTTP_ATTEMPTS - 1) await backoffDelay(attempt, error.retryAfterMs);
            }
        }

        throw lastError;
    };

    const requestJson = async (url) => {
        const { text } = await requestRaw(url, { accept: JSON_ACCEPT });
        return parseJsonText(text, url);
    };

    const requestSearchPage = async (url) => {
        const { text } = await requestRaw(url, { accept: HTML_ACCEPT });
        const data = parseNextData(text, url);
        const pageProps = data?.props?.pageProps;
        if (!pageProps || typeof pageProps !== 'object') {
            throw new Error(`Missing page payload from ${url}`);
        }
        return pageProps;
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
    let pagesProcessed = 0;

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

    let cursor = null;
    let currentPage = 1;
    let stopReason = 'completed';

    while (savedCount < resultsWanted && currentPage <= maxPages) {
        const pageUrl = addCursorToUrl(searchConfig.startSearchUrl, cursor);

        let payload;
        try {
            payload = normalizeJobsPayload(await requestSearchPage(pageUrl));
        } catch (error) {
            stopReason = `listing request failed on page ${currentPage}`;
            log.warning(`Page ${currentPage} listing fetch failed: ${error.message.slice(0, 160)}`);
            break;
        }

        pagesProcessed++;

        if (!payload.jobs.length) {
            stopReason = `no more listings on page ${currentPage}`;
            log.info(`Page ${currentPage}: empty`);
            break;
        }

        const newJobs = payload.jobs.filter((j) => j?.jobKey && !seenJobKeys.has(j.jobKey));
        const remaining = resultsWanted - savedCount;
        const jobsToTake = newJobs.slice(0, remaining);

        for (const job of jobsToTake) seenJobKeys.add(job.jobKey);

        if (!jobsToTake.length) {
            stopReason = 'no new listings found';
            break;
        }

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
                    log.warning(`Detail fetch failed: ${error.message.slice(0, 120)}`);
                }
            }

            const record = buildRecord(job, detail, { viewJobData });
            await queueRecordForSave(record);
        });

        await saveChain;
        await flushBatch(true);

        if (savedCount >= resultsWanted) {
            stopReason = 'requested result count reached';
            break;
        }

        cursor = payload.nextCursor;
        if (!cursor) {
            stopReason = 'no next page cursor';
            break;
        }
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
        log.warning('Records with partial source data remain', {
            missingCompany,
            missingLocation,
        });
    }

    if (!savedCount) {
        throw new Error('No valid records extracted from Workopolis.');
    }

    log.info('Run complete', {
        saved: savedCount,
        pages: pagesProcessed,
        stopReason,
        missingDescriptions,
        missingCompany,
        missingLocation,
    });
});
