// Workopolis.com Jobs Scraper - Production-Ready, Fast & Stealthy
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and got-scraping for HTTP requests
// Priority: 1) Next.js Internal API  2) __NEXT_DATA__ parsing  3) HTML fallback

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// Constants for stealth and performance
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 300;
const MAX_RETRIES = 2;

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

    /**
     * Fetch job details via HTML page (fastest working method)
     */
    const fetchJobDetail = async (jobKey) => {
        try {
            const htmlUrl = `https://www.workopolis.com/jobsearch/viewjob/${jobKey}`;
            const response = await fetchWithRetry(htmlUrl, { referer: 'https://www.workopolis.com/search' });
            const $ = cheerio.load(response.body);

            // Extract from __NEXT_DATA__ in HTML (most reliable)
            const nextDataScript = $('#__NEXT_DATA__').html();
            if (nextDataScript) {
                try {
                    const nextData = JSON.parse(nextDataScript);
                    const viewJobData = nextData.props?.pageProps?.viewJobData;
                    if (viewJobData && viewJobData.jobDescriptionHtml) {
                        return viewJobData;
                    }
                } catch (e) { /* ignore parse errors */ }
            }

            // Fallback: direct HTML parsing
            const descriptionHtml = $('[data-testid="viewJobBodyJobFullDescriptionContent"]').html() ||
                $('.job-description').html() ||
                $('[data-testid="job-description"]').html();

            if (descriptionHtml) {
                return {
                    jobKey,
                    jobDescriptionHtml: descriptionHtml,
                    employerName: $('[data-testid="employer-name"]').text().trim() || null,
                    formattedLocation: $('[data-testid="location"]').text().trim() || null,
                };
            }
        } catch (error) {
            // Silent fail - will return null
        }

        return null;
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
            log.error('Could not extract __NEXT_DATA__. Site may have changed or be blocking.');
            return;
        }

        buildId = nextData.buildId;
        const pageProps = nextData.props?.pageProps;

        if (!pageProps) {
            log.error('No pageProps found - unexpected page structure');
            return;
        }

        log.info(`BuildId: ${buildId}`);

        // Extract jobs from first page
        const pageJobs = pageProps.jobs || [];
        const viewJobData = pageProps.viewJobData || null;
        const cursors = pageProps.pageCursors || {};

        log.info(`Page 1: Found ${pageJobs.length} jobs`);

        if (pageJobs.length === 0) {
            log.warning('No jobs found on first page');
        }

        for (const job of pageJobs) {
            if (seenJobKeys.has(job.jobKey)) continue;
            if (jobs.length >= RESULTS_WANTED) break;

            seenJobKeys.add(job.jobKey);
            const parsedJob = parseJob(job, viewJobData);
            jobs.push(parsedJob);
        }

        // Get cursor for next page
        currentCursor = cursors['2'] || null;
        pageNum = 1;

        log.info(`Collected ${jobs.length} jobs, ${currentCursor ? 'more pages available' : 'no more pages'}`);

    } catch (error) {
        log.error(`Failed to fetch initial page: ${error.message}`);
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
    // Count how many jobs already have descriptions from __NEXT_DATA__ viewJobData
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
        log.info(`Fetching descriptions for ${jobsNeedingDetails} jobs...`);

        let enriched = 0;
        const batchSize = 10; // Process 10 in parallel for speed

        for (let i = 0; i < jobs.length; i += batchSize) {
            const batch = jobs.slice(i, i + batchSize);

            await Promise.all(batch.map(async (job) => {
                if (job.description_html) return; // Already has description

                const detail = await fetchJobDetail(job.jobKey);
                if (detail) {
                    const rawHtml = detail.jobDescriptionHtml || detail.description || null;
                    if (rawHtml) {
                        job.description_html = sanitizeHtml(rawHtml);
                        job.description_text = htmlToCleanText(rawHtml);
                        enriched++;
                    }
                    // Enrich missing fields
                    if (!job.company && detail.employerName) job.company = detail.employerName;
                    if (!job.datePosted) job.datePosted = detail.datePublished || detail.dateOnIndeed;
                    if (!job.location && detail.formattedLocation) job.location = detail.formattedLocation;
                }
            }));

            // Save incrementally
            const currentEnd = Math.min(i + batchSize, jobs.length);
            if (currentEnd >= savedCount + SAVE_BATCH_SIZE || currentEnd === jobs.length) {
                await saveJobsBatch(savedCount, currentEnd);
            }
        }

        log.info(`Enriched ${enriched}/${jobsNeedingDetails} jobs with descriptions`);
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