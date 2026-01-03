// Workopolis.com Jobs Scraper - Production-Ready, Fast & Stealthy
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and got-scraping for HTTP requests
// Priority: 1) Next.js Internal API  2) __NEXT_DATA__ parsing  3) HTML fallback

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

// Constants for stealth and performance
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2000;
const MAX_RETRIES = 3;

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

    let {
        keyword = '',
        location = '',
        posted_date = 'anytime',
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 999,
        collectDetails = true,
        startUrls,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

    // Validate posted_date
    const validPostedDates = ['anytime', '24h', '7d', '30d'];
    if (!validPostedDates.includes(posted_date)) {
        log.warning(`Invalid posted_date: "${posted_date}". Defaulting to "anytime".`);
        posted_date = 'anytime';
    }

    log.info('Starting Workopolis scraper', { keyword, location, results_wanted: RESULTS_WANTED, collectDetails });

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
     * Make HTTP request with retries and stealth
     */
    const fetchWithRetry = async (url, options = {}, retries = MAX_RETRIES) => {
        // Extract referer separately - it's not a valid gotScraping option
        const { referer, ...restOptions } = options;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await randomDelay();
                const response = await gotScraping({
                    url,
                    headers: buildHeaders(referer),
                    proxyUrl,
                    timeout: { request: 30000 },
                    retry: { limit: 0 },
                    ...restOptions,
                });
                return response;
            } catch (error) {
                const status = error.response?.statusCode;
                if (status === 403 || status === 429) {
                    log.warning(`Blocked (${status}) on attempt ${attempt}/${retries}: ${url}`);
                }
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 2000 * attempt)); // Exponential backoff
                } else {
                    throw error;
                }
            }
        }
        throw new Error(`Failed after ${retries} attempts: ${url}`);
    };

    /**
     * Extract __NEXT_DATA__ from HTML
     */
    const extractNextData = (html) => {
        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
        if (!match) return null;
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            log.debug('Failed to parse __NEXT_DATA__');
            return null;
        }
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
     * Build Next.js API URL for faster subsequent pages
     */
    const buildApiUrl = (buildId, query, location, cursor = null) => {
        let path = `/search.json?q=${encodeURIComponent(query || 'jobs')}`;
        if (location) path += `&l=${encodeURIComponent(location)}`;
        if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
        return `https://www.workopolis.com/_next/data/${buildId}${path}`;
    };

    /**
     * Parse job from API/JSON response
     */
    const parseJob = (job, viewJobData = null, debug = false) => {
        // Debug: Log first job structure
        if (debug) {
            log.info(`Job structure keys: ${Object.keys(job).join(', ')}`);
            log.info(`Job sample: ${JSON.stringify(job).substring(0, 500)}`);
        }

        // Get full description from viewJobData if this is the selected job
        let description_html = null;
        let description_text = null;

        if (viewJobData && viewJobData.jobKey === job.jobKey) {
            description_html = viewJobData.description || viewJobData.jobDescription || viewJobData.formattedDescription || null;
            if (description_html) {
                description_text = description_html
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }
        }

        // Extract company - try multiple field paths
        let company = null;
        if (job.company) {
            company = typeof job.company === 'string' ? job.company : job.company.name || job.company.displayName;
        }
        company = company || job.companyName || job.employer || job.hiringOrganization?.name || null;

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

        // Extract date posted - try multiple fields
        const datePosted = job.datePosted || job.postingDate || job.date || job.pubDate || job.postedDate || null;

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

        return {
            url: `https://www.workopolis.com/jobsearch/viewjob/${job.jobKey}`,
            jobKey: job.jobKey,
            title: job.title || job.jobTitle || null,
            company,
            location,
            salary,
            employmentType,
            datePosted,
            requirements: job.requirements || job.qualifications || null,
            description_html,
            description_text,
            _source: 'workopolis.com',
            _fetchedAt: new Date().toISOString(),
        };
    };

    /**
     * Fetch job details via Next.js API
     */
    const fetchJobDetail = async (buildId, jobKey) => {
        try {
            const url = `https://www.workopolis.com/_next/data/${buildId}/jobsearch/viewjob/${jobKey}.json`;
            const response = await fetchWithRetry(url, { referer: 'https://www.workopolis.com/search' });
            const data = JSON.parse(response.body);
            return data.pageProps?.viewJobData || null;
        } catch (error) {
            log.debug(`Failed to fetch detail for ${jobKey}: ${error.message}`);
            return null;
        }
    };

    // ======================== MAIN SCRAPING LOGIC ========================

    const jobs = [];
    const seenJobKeys = new Set();
    let buildId = null;
    let currentCursor = null;
    let pageNum = 0;

    // Determine start URL
    let startSearchUrl;
    if (Array.isArray(startUrls) && startUrls.length > 0) {
        const firstUrl = typeof startUrls[0] === 'string' ? startUrls[0] : startUrls[0]?.url;
        startSearchUrl = firstUrl || buildSearchUrl(keyword, location, posted_date);
    } else {
        startSearchUrl = buildSearchUrl(keyword, location, posted_date);
    }

    log.info(`Starting with URL: ${startSearchUrl}`);

    // ======================== PHASE 1: Initial Page ========================
    try {
        log.info('Fetching initial page...');
        const response = await fetchWithRetry(startSearchUrl);

        // Log response diagnostics
        log.info(`Response received: ${response.statusCode} | Body length: ${response.body?.length || 0} chars`);

        // Check for blocking
        if (response.body?.includes('blocked') || response.body?.includes('captcha') || response.body?.includes('Access Denied')) {
            log.error('Request appears to be blocked. Try using RESIDENTIAL proxies.');
            // Save HTML for debugging
            await Actor.setValue('BLOCKED_PAGE', response.body, { contentType: 'text/html' });
            return;
        }

        const nextData = extractNextData(response.body);

        if (!nextData) {
            log.error('Could not extract __NEXT_DATA__. Site structure may have changed.');
            // Save first 5000 chars for debugging
            const debugHtml = response.body?.substring(0, 5000) || 'Empty response';
            log.warning(`Response preview: ${debugHtml.substring(0, 500)}...`);
            await Actor.setValue('DEBUG_HTML', response.body, { contentType: 'text/html' });
            return;
        }

        buildId = nextData.buildId;
        const pageProps = nextData.props?.pageProps;

        if (!pageProps) {
            log.error('No pageProps found in __NEXT_DATA__');
            log.warning(`__NEXT_DATA__ keys: ${Object.keys(nextData).join(', ')}`);
            log.warning(`props keys: ${Object.keys(nextData.props || {}).join(', ')}`);
            await Actor.setValue('DEBUG_NEXT_DATA', JSON.stringify(nextData, null, 2), { contentType: 'application/json' });
            return;
        }

        log.info(`Extracted buildId: ${buildId}`);

        // Extract jobs from first page
        const pageJobs = pageProps.jobs || [];
        const viewJobData = pageProps.viewJobData || null;
        const cursors = pageProps.pageCursors || {};

        log.info(`Page 1: Found ${pageJobs.length} jobs`);

        // Log if no jobs found
        if (pageJobs.length === 0) {
            log.warning('No jobs found on first page. Checking pageProps structure...');
            log.warning(`pageProps keys: ${Object.keys(pageProps).join(', ')}`);
            await Actor.setValue('DEBUG_PAGE_PROPS', JSON.stringify(pageProps, null, 2), { contentType: 'application/json' });
        } else {
            // Debug: Log first job structure to understand field names
            const firstJob = pageJobs[0];
            log.info(`First job keys: ${Object.keys(firstJob).join(', ')}`);
            if (viewJobData) {
                log.info(`viewJobData keys: ${Object.keys(viewJobData).join(', ')}`);
            }
            // Save full structure for debugging
            await Actor.setValue('DEBUG_FIRST_JOB', JSON.stringify({ firstJob, viewJobData }, null, 2), { contentType: 'application/json' });
        }

        for (const job of pageJobs) {
            if (seenJobKeys.has(job.jobKey)) continue;
            if (jobs.length >= RESULTS_WANTED) break;

            seenJobKeys.add(job.jobKey);
            // Pass debug=true for first job
            const parsedJob = parseJob(job, viewJobData, jobs.length === 0);
            jobs.push(parsedJob);
        }

        // Get cursor for next page
        currentCursor = cursors['2'] || null;
        pageNum = 1;

        log.info(`After page 1: ${jobs.length} jobs collected, nextCursor: ${currentCursor ? 'yes' : 'no'}`);

    } catch (error) {
        log.error(`Failed to fetch initial page: ${error.message}`);
        log.error(`Error stack: ${error.stack}`);
        return;
    }

    // ======================== PHASE 2: Pagination via API ========================
    while (jobs.length < RESULTS_WANTED && currentCursor && pageNum < MAX_PAGES) {
        pageNum++;

        try {
            // Use Next.js API for faster pagination (JSON only, no HTML parsing)
            const apiUrl = buildApiUrl(buildId, keyword || 'jobs', location, currentCursor);
            log.debug(`Fetching page ${pageNum} via API`);

            const response = await fetchWithRetry(apiUrl, {
                referer: 'https://www.workopolis.com/search',
                responseType: 'json'
            });

            let data;
            try {
                data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
            } catch (e) {
                log.warning(`Failed to parse API response on page ${pageNum}`);
                break;
            }

            const pageProps = data.pageProps;
            if (!pageProps) {
                log.warning(`No pageProps in API response on page ${pageNum}`);
                break;
            }

            const pageJobs = pageProps.jobs || [];
            const viewJobData = pageProps.viewJobData || null;
            const cursors = pageProps.pageCursors || {};

            if (pageJobs.length === 0) {
                log.info(`No more jobs found on page ${pageNum}. End of results.`);
                break;
            }

            // Log progress every 5 pages
            if (pageNum % 5 === 0 || pageNum === 2) {
                log.info(`Page ${pageNum}: Found ${pageJobs.length} jobs | Total: ${jobs.length}/${RESULTS_WANTED}`);
            }

            for (const job of pageJobs) {
                if (seenJobKeys.has(job.jobKey)) continue;
                if (jobs.length >= RESULTS_WANTED) break;

                seenJobKeys.add(job.jobKey);
                const parsedJob = parseJob(job, viewJobData);
                jobs.push(parsedJob);
            }

            // Get next cursor
            const nextPageNum = pageNum + 1;
            currentCursor = cursors[String(nextPageNum)] || null;

            if (!currentCursor) {
                // Try to find any remaining cursor
                const cursorKeys = Object.keys(cursors).map(Number).sort((a, b) => a - b);
                const nextKey = cursorKeys.find(k => k > pageNum);
                currentCursor = nextKey ? cursors[String(nextKey)] : null;
            }

        } catch (error) {
            if (error.response?.statusCode === 404) {
                log.warning('BuildId may have changed. Attempting refresh...');
                // Refresh buildId by fetching HTML page
                try {
                    const refreshUrl = buildSearchUrl(keyword, location, posted_date, currentCursor);
                    const response = await fetchWithRetry(refreshUrl);
                    const nextData = extractNextData(response.body);
                    if (nextData?.buildId) {
                        buildId = nextData.buildId;
                        log.info(`Refreshed buildId: ${buildId}`);
                        continue; // Retry with new buildId
                    }
                } catch (e) {
                    log.error('Failed to refresh buildId');
                }
            }
            log.error(`Failed on page ${pageNum}: ${error.message}`);
            break;
        }
    }

    // ======================== PHASE 3: Fetch Job Details (if needed) ========================
    if (collectDetails && buildId) {
        log.info(`Enriching ${jobs.length} jobs with full descriptions...`);

        let enriched = 0;
        const batchSize = 5; // Process in small batches for stealth

        for (let i = 0; i < jobs.length; i += batchSize) {
            const batch = jobs.slice(i, i + batchSize);

            await Promise.all(batch.map(async (job) => {
                if (job.description_html) {
                    enriched++;
                    return; // Already has description from listing
                }

                const detail = await fetchJobDetail(buildId, job.jobKey);
                if (detail) {
                    job.description_html = detail.description || detail.jobDescription || null;
                    if (job.description_html) {
                        job.description_text = job.description_html
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                    }
                    // Additional fields from detail
                    if (!job.datePosted && detail.datePosted) job.datePosted = detail.datePosted;
                    enriched++;
                }
            }));

            // Progress logging
            if ((i + batchSize) % 20 === 0 || i + batchSize >= jobs.length) {
                log.info(`Enrichment progress: ${Math.min(i + batchSize, jobs.length)}/${jobs.length}`);
            }
        }

        log.info(`Enriched ${enriched}/${jobs.length} jobs with descriptions`);
    }

    // ======================== PHASE 4: Save Results ========================
    if (jobs.length > 0) {
        // Push in batches for efficiency
        const batchSize = 50;
        for (let i = 0; i < jobs.length; i += batchSize) {
            const batch = jobs.slice(i, i + batchSize);
            await Dataset.pushData(batch);
        }
        log.info(`✓ Saved ${jobs.length} jobs to dataset`);
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