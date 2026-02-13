// Workopolis.com Jobs Scraper - Production-Ready, Fast & Stealthy
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and got-scraping for HTTP requests
// Pure API mode: 1) Next.js internal JSON API for search 2) /api/next/job JSON API for details

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Constants for stealth and performance
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 1000;
const MAX_RETRIES = 2;
const DETAIL_MAX_CONCURRENCY = 20;
const DETAIL_MAX_RETRIES = 2;
const STATE_KEY = 'STATE';

Actor.main(async () => {
    const startTime = Date.now();

    // Global error handlers
    process.on('unhandledRejection', (reason) => log.error('Unhandled Rejection:', reason));
    process.on('uncaughtException', (error) => log.error('Uncaught Exception:', error));

    // ======================== INPUT VALIDATION ========================
    let input = await Actor.getInput() ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        log.warning('Invalid input format. Using defaults.');
        input = {};
    }

    const isLocalRun = process.env.APIFY_IS_AT_HOME !== '1';
    if (isLocalRun && Object.prototype.hasOwnProperty.call(input, 'buildId')) {
        try {
            const localInputPath = path.join(process.cwd(), 'INPUT.json');
            const localInputRaw = await readFile(localInputPath, 'utf8');
            const localInput = JSON.parse(localInputRaw);
            if (typeof localInput === 'object' && localInput !== null && !Array.isArray(localInput)) {
                input = localInput;
                log.info('Using workspace INPUT.json for local run (ignoring stale storage INPUT).');
            }
        } catch {
            // Keep Actor.getInput() if local INPUT.json is not available/valid
        }
    }

    let {
        keyword: keywordRaw,
        location: locationRaw,
        posted_date: postedDateRaw = 'anytime',
        results_wanted: resultsWantedRaw,
        max_pages: MAX_PAGES_RAW = 10,
        detailConcurrency: DETAIL_CONCURRENCY_RAW = DETAIL_MAX_CONCURRENCY,
        collectDetails = true,
        startUrls,
        proxyConfiguration,
    } = input;

    const requestedJobsRaw = resultsWantedRaw ?? 20;
    const keyword = typeof keywordRaw === 'string' ? keywordRaw.trim() : '';
    const location = typeof locationRaw === 'string' ? locationRaw.trim() : '';
    let posted_date = typeof postedDateRaw === 'string' ? postedDateRaw : 'anytime';

    const RESULTS_WANTED = Number.isFinite(+requestedJobsRaw) ? Math.max(1, +requestedJobsRaw) : 20;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 10;
    const DETAIL_CONCURRENCY = Number.isFinite(+DETAIL_CONCURRENCY_RAW)
        ? Math.max(1, Math.min(50, +DETAIL_CONCURRENCY_RAW))
        : DETAIL_MAX_CONCURRENCY;

    // Validate posted_date
    const validPostedDates = ['anytime', '24h', '7d', '30d'];
    if (!validPostedDates.includes(posted_date)) {
        log.warning(`Invalid posted_date: "${posted_date}". Defaulting to "anytime".`);
        posted_date = 'anytime';
    }

    log.info('Starting Workopolis scraper', {
        keyword: keyword || null,
        location: location || null,
        results_wanted: RESULTS_WANTED,
        collectDetails,
    });

    // ======================== PROXY SETUP ========================
    let proxyUrl = null;
    if (proxyConfiguration) {
        // Fix empty proxy groups
        if (proxyConfiguration.useApifyProxy &&
            Array.isArray(proxyConfiguration.apifyProxyGroups) &&
            proxyConfiguration.apifyProxyGroups.length === 0) {
            proxyConfiguration.apifyProxyGroups = ['RESIDENTIAL'];
        }
        const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
        proxyUrl = await proxyConf?.newUrl();
    } else {
        // Default to RESIDENTIAL for reliability
        const proxyConf = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL']
        });
        proxyUrl = await proxyConf?.newUrl();
    }

    // ======================== HELPER FUNCTIONS ========================

    const randomDelay = () => new Promise(r => setTimeout(r, MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)));
    const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    /**
     * Build stealth headers for requests
     */
    const buildHeaders = (referer = null) => ({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': randomUserAgent(),
        'Dnt': '1',
        ...(referer ? { 'Referer': referer } : {}),
    });

    /**
     * Make HTTP request with delay and retries (for listing pages)
     */
    const fetchWithRetry = async (url, options = {}, retries = MAX_RETRIES) => {
        const { referer, headers: customHeaders = {}, ...restOptions } = options;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await randomDelay();
                const response = await gotScraping({
                    url,
                    headers: {
                        ...buildHeaders(referer),
                        ...customHeaders,
                    },
                    proxyUrl,
                    timeout: { request: 30000 },
                    retry: { limit: 0 },
                    ...restOptions,
                });
                return response;
            } catch (error) {
                const status = error.response?.statusCode;
                if (status === 403) {
                    log.error(`Blocked (403) - Check proxy configuration!`);
                    if (!proxyUrl) {
                        log.error('❌ No proxy detected. Enable Apify Proxy with RESIDENTIAL groups.');
                    }
                } else if (status === 429) {
                    log.warning(`Rate limited (429), backing off...`);
                }
                if (attempt < retries) {
                    const backoff = 3000 * attempt;
                    log.info(`Retry ${attempt}/${retries} in ${backoff}ms...`);
                    await new Promise(r => setTimeout(r, backoff));
                } else {
                    throw error;
                }
            }
        }
        throw new Error(`Failed after ${retries} attempts`);
    };

    /**
     * Fast API request for detail enrichment (no random delay, short backoff)
     */
    const fetchApiFast = async (url, options = {}, retries = DETAIL_MAX_RETRIES) => {
        const { referer, headers: customHeaders = {}, ...restOptions } = options;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await gotScraping({
                    url,
                    headers: {
                        ...buildHeaders(referer),
                        ...customHeaders,
                    },
                    proxyUrl,
                    timeout: { request: 12000 },
                    retry: { limit: 0 },
                    ...restOptions,
                });
                return response;
            } catch (error) {
                if (attempt < retries) {
                    const shortBackoff = 500 * attempt;
                    await new Promise((resolve) => setTimeout(resolve, shortBackoff));
                } else {
                    throw error;
                }
            }
        }

        throw new Error(`Failed fast API request after ${retries} attempts`);
    };

    /**
     * Build search URL
     */
    const buildSearchUrl = (kw, loc, date, cursor = null) => {
        const url = new URL('https://www.workopolis.com/search');
        url.searchParams.set('q', kw?.trim() || 'jobs');
        if (loc?.trim()) url.searchParams.set('l', loc.trim());
        if (date && date !== 'anytime') url.searchParams.set('posted', date);
        if (cursor) url.searchParams.set('cursor', cursor);
        return url.href;
    };

    /**
     * Build Next.js search API URL
     */
    const buildApiUrl = (buildId, query, location, cursor = null) => {
        let path = `/search.json?q=${encodeURIComponent(query || 'jobs')}`;
        if (location) path += `&l=${encodeURIComponent(location)}`;
        if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
        return `https://www.workopolis.com/_next/data/${buildId}${path}`;
    };

    /**
     * Fetch pageProps from Next.js search API
     */
    const fetchSearchPageProps = async (activeBuildId, query, activeLocation, cursor = null) => {
        const apiUrl = buildApiUrl(activeBuildId, query || 'jobs', activeLocation, cursor);
        const response = await fetchWithRetry(apiUrl, {
            referer: 'https://www.workopolis.com/search',
            headers: {
                Accept: 'application/json, text/plain, */*',
            },
            responseType: 'json',
        });

        const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
        return data?.pageProps || null;
    };

    const fetchJobsPageData = async (query, activeLocation, locale, postedDate, cursor = null) => {
        const url = new URL('https://www.workopolis.com/api/next/jobs');
        url.searchParams.set('q', query || 'jobs');
        if (activeLocation) url.searchParams.set('l', activeLocation);
        if (locale) url.searchParams.set('locale', locale);
        if (cursor) url.searchParams.set('cursor', cursor);

        const postedDateToT = {
            anytime: '',
            '24h': '1',
            '7d': '7',
            '30d': '30',
        };
        const tValue = postedDateToT[postedDate] ?? '';
        if (tValue) url.searchParams.set('t', tValue);

        const response = await fetchWithRetry(url.href, {
            referer: 'https://www.workopolis.com/search',
            headers: {
                Accept: 'application/json, text/plain, */*',
            },
            responseType: 'json',
        });

        return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    };

    const parseCursorFromUrl = (url) => {
        if (!url || typeof url !== 'string') return null;
        try {
            const parsed = new URL(url, 'https://www.workopolis.com');
            return parsed.searchParams.get('cursor');
        } catch {
            return null;
        }
    };

    const normalizeJobsPayload = (payload) => {
        const pageProps = payload?.pageProps || payload?.data || payload || {};
        const pageCursors = pageProps.pageCursors || payload?.pageCursors || {};
        const currentPageNumber = pageProps.currentPageNumber || payload?.currentPageNumber || 1;
        const nextCursor =
            pageProps.nextCursor
            || payload?.nextCursor
            || pageCursors[String(Number(currentPageNumber) + 1)]
            || parseCursorFromUrl(pageProps.nextPageUrl || payload?.nextPageUrl)
            || null;

        return {
            jobs: Array.isArray(pageProps.jobs) ? pageProps.jobs : [],
            viewJobData: pageProps.viewJobData || null,
            pageCursors,
            currentPageNumber,
            nextCursor,
        };
    };

    const discoverBuildId = async (searchUrl) => {
        const response = await fetchWithRetry(searchUrl, {
            referer: 'https://www.workopolis.com/',
            responseType: 'text',
        });

        const html = typeof response.body === 'string' ? response.body : String(response.body || '');
        if (!html) return null;

        const direct = html.match(/"buildId"\s*:\s*"([^"]+)"/i)?.[1];
        if (direct) return direct;

        const manifest = html.match(/_next\/static\/([^/]+)\/_buildManifest\.js/i)?.[1];
        if (manifest) return manifest;

        return null;
    };

    const detailCache = new Map();
    const detailInFlight = new Map();

    /**
     * Fast API-only detail fetch (no HTML parsing)
     */
    const fetchJobDetailFromApi = async (jobKey, locale, continueUrl, jobCardTrackingKey = null) => {
        if (!jobKey || !locale || !continueUrl) return null;

        if (detailCache.has(jobKey)) return detailCache.get(jobKey);
        if (detailInFlight.has(jobKey)) return detailInFlight.get(jobKey);

        const requestPromise = (async () => {
            try {
                const url = new URL('https://www.workopolis.com/api/next/job');
                url.searchParams.set('key', jobKey);
                url.searchParams.set('locale', locale);
                url.searchParams.set('indeedApplyContinueUrl', continueUrl);
                if (jobCardTrackingKey) url.searchParams.set('jobCardTrackingKey', jobCardTrackingKey);

                const response = await fetchApiFast(url.href, {
                    referer: continueUrl,
                    headers: {
                        Accept: 'application/json, text/plain, */*',
                    },
                    responseType: 'json',
                });

                const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                const normalized = data?.jobKey === jobKey ? data : null;
                detailCache.set(jobKey, normalized);
                return normalized;
            } catch {
                detailCache.set(jobKey, null);
                return null;
            } finally {
                detailInFlight.delete(jobKey);
            }
        })();

        detailInFlight.set(jobKey, requestPromise);
        return requestPromise;
    };

    const runWithConcurrency = async (items, concurrency, worker) => {
        const limit = Math.max(1, concurrency);
        let index = 0;

        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const currentIndex = index++;
                await worker(items[currentIndex], currentIndex);
            }
        });

        await Promise.all(runners);
    };

    /**
     * Sanitize HTML - keep only semantic tags, remove attributes
     */
    const sanitizeHtml = (html) => {
        if (!html) return null;

        // Allowed tags for job descriptions
        const allowedTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'a', 'div', 'span'];

        let cleaned = html
            // Remove script/style tags and their content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            // Remove all attributes except href on anchors
            .replace(/<(\w+)([^>]*)>/gi, (match, tag, attrs) => {
                const tagLower = tag.toLowerCase();
                if (!allowedTags.includes(tagLower)) {
                    // Convert non-allowed block tags to div, inline to span
                    const blockTags = ['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav'];
                    if (blockTags.includes(tagLower)) return '<div>';
                    return '<span>';
                }
                // For anchor tags, keep href
                if (tagLower === 'a') {
                    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
                    return hrefMatch ? `<a href="${hrefMatch[1]}">` : '<a>';
                }
                return `<${tagLower}>`;
            })
            // Fix closing tags
            .replace(/<\/(\w+)>/gi, (match, tag) => {
                const tagLower = tag.toLowerCase();
                if (!allowedTags.includes(tagLower)) {
                    const blockTags = ['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav'];
                    if (blockTags.includes(tagLower)) return '</div>';
                    return '</span>';
                }
                return `</${tagLower}>`;
            })
            // Remove empty tags
            .replace(/<(\w+)>\s*<\/\1>/gi, '')
            // Normalize whitespace
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned || null;
    };

    /**
     * Convert HTML to clean readable text with proper formatting
     */
    const htmlToCleanText = (html) => {
        if (!html) return null;

        let text = html
            // Add line breaks before block elements
            .replace(/<\/(h[1-6]|p|div|li|tr)>/gi, '</$1>\n')
            .replace(/<(h[1-6]|p|div)[^>]*>/gi, '\n')
            // Handle lists - add bullet points
            .replace(/<li[^>]*>/gi, '\n• ')
            .replace(/<\/li>/gi, '')
            // Handle line breaks
            .replace(/<br\s*\/?>/gi, '\n')
            // Remove all remaining HTML tags
            .replace(/<[^>]+>/g, '')
            // Decode common HTML entities
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&rsquo;/gi, "'")
            .replace(/&lsquo;/gi, "'")
            .replace(/&rdquo;/gi, '"')
            .replace(/&ldquo;/gi, '"')
            .replace(/&ndash;/gi, '–')
            .replace(/&mdash;/gi, '—')
            .replace(/&bull;/gi, '•')
            // Clean up whitespace
            .replace(/[ \t]+/g, ' ')  // Multiple spaces to single
            .replace(/\n[ \t]+/g, '\n')  // Remove leading spaces on lines
            .replace(/[ \t]+\n/g, '\n')  // Remove trailing spaces on lines
            .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
            .trim();

        return text || null;
    };

    /**
     * Parse job from API/JSON response
     */
    const parseJob = (job, viewJobData = null) => {
        // Get full description from viewJobData if this is the selected job
        let description_html = null;
        let description_text = null;

        if (viewJobData && viewJobData.jobKey === job.jobKey) {
            const rawHtml = viewJobData.jobDescriptionHtml || viewJobData.description || null;
            if (rawHtml) {
                description_html = sanitizeHtml(rawHtml);
                description_text = htmlToCleanText(rawHtml);
            }
        }

        // Extract company - try multiple field paths
        let company = null;
        if (job.company) {
            company = typeof job.company === 'string' ? job.company : job.company.name || job.company.displayName;
        }
        company = company || job.companyName || job.employer || null;
        // Fallback to viewJobData.employerName
        if (!company && viewJobData && viewJobData.jobKey === job.jobKey) {
            company = viewJobData.employerName;
        }

        // Extract salary info
        let salary = null;
        if (job.salaryInfo) {
            const { min, max, type } = job.salaryInfo;
            if (min || max) {
                const salaryType = type === 'YEARLY' ? '/year' : type === 'HOURLY' ? '/hour' : '';
                if (min && max) {
                    salary = `$${min.toLocaleString()} - $${max.toLocaleString()}${salaryType}`;
                } else if (min) {
                    salary = `From $${min.toLocaleString()}${salaryType}`;
                } else if (max) {
                    salary = `Up to $${max.toLocaleString()}${salaryType}`;
                }
            }
        }
        // Fallback to string salary
        salary = salary || job.salary || job.salaryText || job.compensation || null;

        // Extract date posted - dateOnIndeed or datePublished are the correct fields
        let datePosted = job.dateOnIndeed || job.datePublished || job.datePosted || null;
        if (!datePosted && viewJobData && viewJobData.jobKey === job.jobKey) {
            datePosted = viewJobData.datePublished || viewJobData.dateOnIndeed;
        }

        // Extract location - handle object or string
        let location = null;
        if (job.location) {
            location = typeof job.location === 'string' ? job.location :
                job.location.displayName || job.location.city ||
                [job.location.city, job.location.province].filter(Boolean).join(', ');
        }
        location = location || job.formattedLocation || job.jobLocation || null;

        // Extract employment type
        let employmentType = null;
        if (job.jobTypes && Array.isArray(job.jobTypes)) {
            employmentType = job.jobTypes.join(', ');
        } else if (job.employmentType) {
            employmentType = Array.isArray(job.employmentType) ? job.employmentType.join(', ') : job.employmentType;
        }
        employmentType = employmentType || job.jobType || job.type || null;

        // Extract benefits
        let benefits = null;
        if (job.benefits && Array.isArray(job.benefits)) {
            benefits = job.benefits.map(b => typeof b === 'string' ? b : b.label || b.name).filter(Boolean).join(', ');
        }

        // Extract remote/work settings
        let workSettings = null;
        if (job.remoteAttributes) {
            workSettings = job.remoteAttributes.displayValue || (job.remoteAttributes.isRemote ? 'Remote' : null);
        }
        if (!workSettings && viewJobData && viewJobData.jobKey === job.jobKey && viewJobData.workSettings) {
            workSettings = Array.isArray(viewJobData.workSettings) ? viewJobData.workSettings.join(', ') : viewJobData.workSettings;
        }

        // Format requirements - top 5 items as comma-separated string
        let requirements = null;
        if (job.requirements && Array.isArray(job.requirements)) {
            requirements = job.requirements.slice(0, 5).join(', ');
        } else if (typeof job.requirements === 'string') {
            requirements = job.requirements;
        }

        return {
            url: `https://www.workopolis.com/jobsearch/viewjob/${job.jobKey}`,
            jobKey: job.jobKey,
            title: job.title || job.jobTitle || null,
            company,
            location,
            salary,
            employmentType,
            workSettings,
            datePosted,
            benefits,
            snippet: job.snippet || null,
            requirements,
            description_html,
            description_text,
            _source: 'workopolis.com',
            _fetchedAt: new Date().toISOString(),
        };
    };

    // ======================== MAIN SCRAPING LOGIC ========================

    const jobs = [];
    const seenJobKeys = new Set();
    const jobMetaByKey = new Map();
    let buildId = null;
    let listingMode = 'nextData';
    let currentCursor = null;
    let pageNum = 0;

    // Determine start URL and API query params
    let startSearchUrl;
    if (Array.isArray(startUrls) && startUrls.length > 0) {
        const firstUrl = typeof startUrls[0] === 'string' ? startUrls[0] : startUrls[0]?.url;
        startSearchUrl = firstUrl || buildSearchUrl(keyword, location, posted_date);
    } else {
        startSearchUrl = buildSearchUrl(keyword, location, posted_date);
    }

    let apiKeyword = keyword || 'jobs';
    let apiLocation = location;
    let apiLocale = 'en-CA';
    try {
        const startUrlObj = new URL(startSearchUrl);
        apiKeyword = startUrlObj.searchParams.get('q') || apiKeyword;
        apiLocation = startUrlObj.searchParams.get('l') || apiLocation;
        const localeMatch = startUrlObj.pathname.match(/^\/(en-CA|fr-CA)(\/|$)/i);
        if (localeMatch?.[1]) apiLocale = localeMatch[1];
    } catch {
        // Keep default keyword/location
    }

    log.info(`Starting with URL: ${startSearchUrl}`);

    const processPageData = (pageProps, activePageNum) => {
        const pageJobs = pageProps.jobs || [];
        const viewJobData = pageProps.viewJobData || null;
        const cursors = pageProps.pageCursors || {};

        log.info(`Page ${activePageNum}: Found ${pageJobs.length} jobs`);

        for (const job of pageJobs) {
            if (seenJobKeys.has(job.jobKey)) continue;
            if (jobs.length >= RESULTS_WANTED) break;

            seenJobKeys.add(job.jobKey);
            jobMetaByKey.set(job.jobKey, {
                jobCardTrackingKey: job.jobCardTrackingKey || null,
            });
            const parsedJob = parseJob(job, viewJobData);
            jobs.push(parsedJob);
        }

        return cursors;
    };

    // ======================== PHASE 1: Initial Data (API-only) ========================
    const state = await Actor.getValue(STATE_KEY) || {};
    const buildIdCandidates = [
        typeof state?.lastBuildId === 'string' ? state.lastBuildId.trim() : null,
        ...(Array.isArray(state?.buildIdHistory) ? state.buildIdHistory : []),
    ].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);

    try {
        const discoveredBuildId = await discoverBuildId(startSearchUrl);
        if (discoveredBuildId && !buildIdCandidates.includes(discoveredBuildId)) {
            buildIdCandidates.unshift(discoveredBuildId);
            log.info(`Discovered internal buildId from page source: ${discoveredBuildId}`);
        }
    } catch (error) {
        log.warning(`Could not discover buildId from page source: ${error.message}`);
    }

    for (const candidateBuildId of buildIdCandidates) {
        try {
            log.info(`Trying API with internal buildId candidate: ${candidateBuildId}`);
            const pageProps = await fetchSearchPageProps(candidateBuildId, apiKeyword, apiLocation, null);
            if (!pageProps || !Array.isArray(pageProps.jobs)) continue;

            buildId = candidateBuildId;
            const cursors = processPageData(pageProps, 1);
            currentCursor = cursors['2'] || null;
            pageNum = 1;
            log.info(`API bootstrap succeeded with internal buildId ${candidateBuildId}`);
            break;
        } catch (error) {
            log.warning(`Internal buildId failed: ${candidateBuildId}`);
        }
    }

    if (!buildId) {
        try {
            const firstPageRaw = await fetchJobsPageData(apiKeyword, apiLocation, apiLocale, posted_date, null);
            const firstPage = normalizeJobsPayload(firstPageRaw);
            if (firstPage.jobs.length > 0) {
                listingMode = 'jobsApi';
                processPageData(firstPage, 1);
                pageNum = Number(firstPage.currentPageNumber) || 1;
                currentCursor = firstPage.nextCursor;
                log.info('Bootstrapped via /api/next/jobs (buildId-free mode)');
            } else {
                log.error('API-only mode could not bootstrap: no jobs from internal buildId or /api/next/jobs');
                return;
            }
        } catch (error) {
            log.error(`API-only mode could not bootstrap: ${error.message}`);
            return;
        }
    } else {
        listingMode = 'nextData';
    }

    if (buildId) {
        const history = Array.isArray(state?.buildIdHistory) ? state.buildIdHistory : [];
        const nextHistory = [buildId, ...history.filter((item) => item !== buildId)].slice(0, 5);
        await Actor.setValue(STATE_KEY, {
            ...state,
            lastBuildId: buildId,
            buildIdHistory: nextHistory,
            updatedAt: new Date().toISOString(),
        });
    }

    // ======================== PHASE 2: Pagination via API ========================
    while (jobs.length < RESULTS_WANTED && currentCursor && pageNum < MAX_PAGES) {
        pageNum++;

        try {
            log.debug(`Fetching page ${pageNum} via API (${listingMode})`);

            let pagePayload = null;
            if (listingMode === 'nextData') {
                const pageProps = await fetchSearchPageProps(buildId, apiKeyword, apiLocation, currentCursor);
                if (!pageProps) {
                    log.warning(`No pageProps in API response on page ${pageNum}`);
                    break;
                }
                pagePayload = {
                    jobs: pageProps.jobs || [],
                    viewJobData: pageProps.viewJobData || null,
                    pageCursors: pageProps.pageCursors || {},
                    currentPageNumber: pageNum,
                    nextCursor: (pageProps.pageCursors || {})[String(pageNum + 1)] || null,
                };
            } else {
                const pageRaw = await fetchJobsPageData(apiKeyword, apiLocation, apiLocale, posted_date, currentCursor);
                pagePayload = normalizeJobsPayload(pageRaw);
            }

            const pageJobs = pagePayload.jobs || [];
            const cursors = pagePayload.pageCursors || {};

            if (pageJobs.length === 0) {
                log.info(`No more jobs found on page ${pageNum}. End of results.`);
                break;
            }

            // Log progress every 5 pages
            if (pageNum % 5 === 0 || pageNum === 2) {
                log.info(`Page ${pageNum}: Found ${pageJobs.length} jobs | Total: ${jobs.length}/${RESULTS_WANTED}`);
            }

            processPageData(pagePayload, pageNum);

            // Get next cursor
            const nextPageNum = pageNum + 1;
            currentCursor = cursors[String(nextPageNum)] || pagePayload.nextCursor || null;

            if (!currentCursor) {
                // Try to find any remaining cursor
                const cursorKeys = Object.keys(cursors).map(Number).sort((a, b) => a - b);
                const nextKey = cursorKeys.find(k => k > pageNum);
                currentCursor = nextKey ? cursors[String(nextKey)] : null;
            }

        } catch (error) {
            log.error(`Failed on page ${pageNum}: ${error.message}`);
            break;
        }
    }

    // ======================== PHASE 3: Fetch Job Details (if needed) ========================
    // Count how many jobs already include descriptions from listing API data
    const jobsWithDescription = jobs.filter(j => j.description_html).length;
    const jobsNeedingDetails = jobs.length - jobsWithDescription;

    log.info(`Jobs with description from listing: ${jobsWithDescription}/${jobs.length}`);

    // Track which jobs have been saved
    let savedCount = 0;
    const SAVE_BATCH_SIZE = 10;

    // Helper to save a batch of jobs
    const saveJobsBatch = async (startIdx, endIdx) => {
        const batch = jobs.slice(startIdx, endIdx);
        if (batch.length > 0) {
            await Dataset.pushData(batch);
            savedCount = endIdx;
            log.info(`✓ Saved jobs ${startIdx + 1}-${endIdx} to dataset (${savedCount}/${jobs.length})`);
        }
    };

    if (collectDetails && jobsNeedingDetails > 0) {
        log.info(`Fetching descriptions for ${jobsNeedingDetails} jobs with concurrency ${DETAIL_CONCURRENCY}...`);

        let enriched = 0;
        const jobsWithoutDescription = jobs.filter((job) => !job.description_html || !job.description_text);
        await runWithConcurrency(jobsWithoutDescription, DETAIL_CONCURRENCY, async (job) => {
            const jobMeta = jobMetaByKey.get(job.jobKey) || {};
            const detail = await fetchJobDetailFromApi(
                job.jobKey,
                apiLocale,
                startSearchUrl,
                jobMeta.jobCardTrackingKey,
            );
            if (!detail) return;

            const rawHtml = detail.jobDescriptionHtml || detail.description || null;
            if (rawHtml) {
                job.description_html = sanitizeHtml(rawHtml);
                job.description_text = htmlToCleanText(rawHtml);
                enriched++;
            }
            if (!job.company && detail.employerName) job.company = detail.employerName;
            if (!job.datePosted) job.datePosted = detail.datePublished || detail.dateOnIndeed;
            if (!job.location && detail.formattedLocation) job.location = detail.formattedLocation;
        });

        // Second pass for reliability with lower concurrency
        const missingAfterFirstPass = jobs.filter((job) => !job.description_html || !job.description_text);
        if (missingAfterFirstPass.length > 0) {
            const retryConcurrency = Math.max(2, Math.floor(DETAIL_CONCURRENCY / 2));
            log.info(`Retrying API details for ${missingAfterFirstPass.length} jobs with concurrency ${retryConcurrency}...`);
            await runWithConcurrency(missingAfterFirstPass, retryConcurrency, async (job) => {
                detailCache.delete(job.jobKey);
                const jobMeta = jobMetaByKey.get(job.jobKey) || {};
                const detail = await fetchJobDetailFromApi(
                    job.jobKey,
                    apiLocale,
                    startSearchUrl,
                    jobMeta.jobCardTrackingKey,
                );
                if (!detail) return;

                const rawHtml = detail.jobDescriptionHtml || detail.description || null;
                if (rawHtml) {
                    job.description_html = sanitizeHtml(rawHtml);
                    job.description_text = htmlToCleanText(rawHtml);
                }
                if (!job.company && detail.employerName) job.company = detail.employerName;
                if (!job.datePosted) job.datePosted = detail.datePublished || detail.dateOnIndeed;
                if (!job.location && detail.formattedLocation) job.location = detail.formattedLocation;
            });
        }

        log.info(`Enriched ${enriched}/${jobsNeedingDetails} jobs with descriptions`);

        const missingAfterEnrichment = jobs.filter((job) => !job.description_html || !job.description_text).length;
        if (missingAfterEnrichment > 0) {
            log.warning(`Descriptions missing after API enrichment: ${missingAfterEnrichment}/${jobs.length}`);
        } else {
            log.info(`All ${jobs.length} jobs have description_html and description_text`);
        }
    } else if (!collectDetails) {
        log.info('Skipping detail page fetches (collectDetails=false) for faster execution');
    } else if (jobsNeedingDetails === 0) {
        log.info('All jobs already have descriptions from listing data - no detail fetches needed!');
    }

    // ======================== PHASE 4: Save Remaining Results ========================
    if (savedCount < jobs.length) {
        await saveJobsBatch(savedCount, jobs.length);
    }

    if (jobs.length > 0) {
        log.info(`✓ All ${jobs.length} jobs saved to dataset`);
    } else {
        log.warning('No jobs scraped. Check search parameters or site availability.');
    }

    // ======================== FINAL STATS ========================
    const executionTime = Math.round((Date.now() - startTime) / 1000);
    const jobsPerSecond = jobs.length > 0 ? (jobs.length / executionTime).toFixed(2) : 0;

    log.info('='.repeat(50));
    log.info(`Scraping Complete!`);
    log.info(`  Jobs scraped: ${jobs.length}/${RESULTS_WANTED}`);
    log.info(`  Pages crawled: ${pageNum}`);
    log.info(`  Execution time: ${executionTime}s`);
    log.info(`  Speed: ${jobsPerSecond} jobs/sec`);
    log.info('='.repeat(50));
});