// Workopolis.com jobs scraper (CheerioCrawler)
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and crawlee@^3

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

// ------------------------- INPUT -------------------------
const input = await Actor.getInput() ?? {};
const {
    keyword = '',
    location = '',
    posted_date = 'anytime',

    results_wanted: RESULTS_WANTED_RAW = 100,
    max_pages: MAX_PAGES_RAW = 999,

    collectDetails = true,

    startUrl,
    url,
    startUrls,

    cookies,
    cookiesJson,
    proxyConfiguration,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

// ------------------------- HELPERS -------------------------
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
];

const buildStartUrl = (kw, loc, date) => {
    // Workopolis uses a few different search endpoints; prefer /search which is stable.
    // If keyword is empty, use 'browse' to show general listings similar to the UI example.
    const url = new URL('https://www.workopolis.com/search');
    url.searchParams.set('q', kw && String(kw).trim() ? String(kw).trim() : 'browse');
    if (loc && String(loc).trim()) url.searchParams.set('l', String(loc).trim());
    // Keep posted_date if provided and not 'anytime' - may be ignored by the site but safe to include
    if (date && date !== 'anytime') url.searchParams.set('posted', String(date));
    return url.href;
};

const toAbs = (href) => {
    try { return new URL(href, 'https://www.workopolis.com').href; } catch { return null; }
};

const collectJobLinks = ($, baseUrl) => {
    // Broad heuristics to capture job detail links on Workopolis search pages.
    const links = new Set();

    const anchorCandidates = [];

    // Common containers
    anchorCandidates.push(...$('a[href]')); // start with all anchors and filter below

    // Filter anchors that look like job detail pages
    const jobHrefRx = /\/job(\/|[-_a-zA-Z0-9?=&%]+)|\/(?:en\/)?job[s]?[-_a-zA-Z0-9]*/i;

    anchorCandidates.forEach((i, a) => {
        try {
            const href = String($(a).attr('href') || '').trim();
            if (!href) return;
            // ignore anchors that are page anchors or javascript
            if (/^#|^javascript:/i.test(href)) return;

            // If href contains 'job' token it's likely a detail link
            if (jobHrefRx.test(href) || /job[-_]?id=|jobId=|/i.test(href)) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs) links.add(abs);
                return;
            }

            // Heuristic: anchors inside listing items
            const parent = $(a).closest('li, article, .result, .job, .search-result, .job-listing');
            if (parent && parent.length) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs && abs.includes('workopolis.com')) links.add(abs);
            }
        } catch (e) {
            // ignore
        }
    });

    // Return unique links with some ordering
    return [...links].filter(Boolean);
};

const findNextUrl = ($, currentUrl) => {
    // Try common next-link patterns first
    const relNext = $('a[rel="next"]').attr('href');
    if (relNext) return toAbs(relNext) || null;

    const ariaNext = $('a[aria-label*="next" i], button[aria-label*="next" i]').first().attr('href');
    if (ariaNext) return toAbs(ariaNext) || null;

    // Pagination next button (case-insensitive text match)
    const nextByText = $('a, button').filter((_, el) => /next|›|»/i.test($(el).text())).first().attr('href');
    if (nextByText) return toAbs(nextByText) || null;

    // Try to find active page and take its next sibling's href
    const active = $('.pagination .active, .pagination li.active, .pagination li.current').first();
    if (active && active.length) {
        const next = active.next('li').find('a').attr('href');
        if (next) return toAbs(next) || null;
    }

    // Fallback: increment common page query params (page, p, pg)
    try {
        const u = new URL(currentUrl);
        const pageParamCandidates = ['page', 'p', 'pg', 'pageNumber', 'start'];
        for (const p of pageParamCandidates) {
            if (u.searchParams.has(p)) {
                const cur = Number(u.searchParams.get(p) || '1');
                if (!Number.isNaN(cur)) {
                    u.searchParams.set(p, String(cur + 1));
                    return u.href;
                }
            }
        }

        // If no page param, try adding 'page=2' when the url has a search path
        if (![...u.searchParams.keys()].length) {
            u.searchParams.set('page', '2');
            return u.href;
        }
    } catch (e) {
        // ignore
    }

    return null;
};

const findBestDescriptionContainer = ($) => {
    const orderedSelectors = [
        '.viewjob-description',
        '.job-description',
        '[data-qa="job-description"]',
    ];
    for (const sel of orderedSelectors) {
        const el = $(sel).first();
        if (el && el.length && el.text().trim().length > 120) return el;
    }
    const scope = $('main, article, [role="main"], .content').first().length
        ? $('main, article, [role="main"], .content').first()
        : $('body');

    let best = null;
    let bestScore = 0;

    const badRx = /Similar Jobs|Recommended courses|Create alerts|Frequently Asked Questions|Apply on the go|Browse jobs|Filters/i;

    scope.find('section, div').each((_, el) => {
        const $el = $(el);
        const txt = $el.text().trim();
        const len = txt.length;
        if (len < 200) return;
        if (badRx.test(txt)) return;
        const bonus = ($el.find('li').length ? 150 : 0) + ($el.find('h1,h2,h3').length ? 50 : 0);
        const score = len + bonus;
        if (score > bestScore) {
            bestScore = score;
            best = $el;
        }
    });

    return best || scope;
};

// Sanitize job description HTML: remove ALL hyperlinks and unwanted tags
const sanitizeHtmlString = (rawHtml) => {
    if (!rawHtml) return '';
    let html = rawHtml
        .replace(/<\s*(script|style|nav|header|footer|button|svg|img|form|aside)[\s\S]*?<\/\s*\1\s*>/gi, '');

    // Remove ALL hyperlinks completely (anchor + inner text)
    html = html.replace(/<a[^>]*>.*?<\/a>/gi, '');

    // Strip attributes from allowed tags
    html = html.replace(/<\s*(p|ul|ol|li|strong|em|h1|h2|h3)\b[^>]*>/gi, '<$1>');

    // Unwrap disallowed tags
    html = html.replace(/<\/?(?!p|br|ul|ol|li|strong|em|h1|h2|h3)\w+[^>]*>/gi, '');

    return html.trim();
};

const htmlToText = (html) => (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const normalizeCookieHeader = ({ cookies, cookiesJson }) => {
    if (cookies && typeof cookies === 'string' && cookies.trim()) return cookies.trim();
    if (cookiesJson && typeof cookiesJson === 'string') {
        try {
            const parsed = JSON.parse(cookiesJson);
            const parts = [];
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (typeof item === 'string') parts.push(item.trim());
                    else if (item && typeof item === 'object' && item.name) {
                        parts.push(`${item.name}=${item.value ?? ''}`);
                    }
                }
            } else if (parsed && typeof parsed === 'object') {
                for (const [k, v] of Object.entries(parsed)) parts.push(`${k}=${v ?? ''}`);
            }
            if (parts.length) return parts.join('; ');
        } catch {}
    }
    return '';
};

// ------------------------- START URLS -------------------------
const builtStartUrl = buildStartUrl(keyword, location, posted_date);
const initialUrls = [];
if (Array.isArray(startUrls) && startUrls.length) initialUrls.push(...startUrls);
if (startUrl && typeof startUrl === 'string') initialUrls.push(startUrl);
if (url && typeof url === 'string') initialUrls.push(url);
if (!initialUrls.length) initialUrls.push(builtStartUrl);

// ------------------------- PROXY -------------------------
const proxyConf = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

// ------------------------- SHARED STATE -------------------------
let jobsScraped = 0; // Actual jobs pushed to dataset
let jobsEnqueued = 0; // Jobs enqueued for detail scraping
let shouldStopEnqueuing = false; // Stop enqueueing new jobs
const cookieHeader = normalizeCookieHeader({ cookies, cookiesJson });

// ------------------------- CRAWLER -------------------------
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConf,
    maxRequestsPerMinute: 120,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 60,
    maxConcurrency: 5,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 30,
            maxErrorScore: 3,
        },
    },
    preNavigationHooks: [
        async ({ request }) => {
            // Anti-blocking headers
            request.headers = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,en-GB;q=0.8,en-CA;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0',
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                ...request.headers,
            };
            
            if (cookieHeader) {
                request.headers.Cookie = cookieHeader;
            }
        }
    ],
    
    async requestHandler({ request, $, log: crawlerLog, enqueueLinks, crawler }) {
        const { label, pageNo = 1 } = request.userData ?? {};

        if (label === 'LIST' || !label) {
            const links = collectJobLinks($, request.url);
            crawlerLog.info(`LIST page ${pageNo}: Found ${links.length} jobs | Scraped: ${jobsScraped}/${RESULTS_WANTED} | Enqueued: ${jobsEnqueued}`);

            if (!collectDetails) {
                // Direct push mode - stop as soon as we reach the limit
                for (const link of links) {
                    if (jobsScraped >= RESULTS_WANTED) {
                        shouldStopEnqueuing = true;
                        break;
                    }
                    await Dataset.pushData({
                        url: link,
                        _source: 'workopolis.com',
                        _fetchedAt: new Date().toISOString(),
                        _from: 'list'
                    });
                    jobsScraped++;
                    crawlerLog.info(`✓ Job ${jobsScraped}/${RESULTS_WANTED} saved (list mode)`);
                }
            } else {
                // Detail mode - only enqueue what we need
                if (!shouldStopEnqueuing) {
                    const remaining = RESULTS_WANTED - jobsEnqueued;
                    const linksToEnqueue = links.slice(0, Math.max(0, remaining));
                    
                    if (linksToEnqueue.length > 0) {
                        await enqueueLinks({
                            urls: linksToEnqueue,
                            userData: { label: 'DETAIL' }
                        });
                        jobsEnqueued += linksToEnqueue.length;
                        crawlerLog.info(`→ Enqueued ${linksToEnqueue.length} detail pages | Total enqueued: ${jobsEnqueued}/${RESULTS_WANTED}`);
                    }
                    
                    // Stop enqueueing if we've reached the limit
                    if (jobsEnqueued >= RESULTS_WANTED) {
                        shouldStopEnqueuing = true;
                        crawlerLog.info(`✓ Reached target: ${jobsEnqueued} jobs enqueued. Stopping pagination.`);
                        return;
                    }
                }
            }

            // Check if we should stop pagination
            if (shouldStopEnqueuing || jobsScraped >= RESULTS_WANTED) {
                crawlerLog.info(`Stopping pagination. Scraped: ${jobsScraped}, Enqueued: ${jobsEnqueued}`);
                return;
            }

            // Check page limit
            if (pageNo >= MAX_PAGES) {
                crawlerLog.info(`Max pages (${MAX_PAGES}) reached. Stopping pagination.`);
                return;
            }

            // Continue to next page if needed
            const nextUrl = findNextUrl($, request.url);
            if (nextUrl) {
                await enqueueLinks({
                    urls: [nextUrl],
                    userData: { label: 'LIST', pageNo: pageNo + 1 }
                });
                crawlerLog.info(`→ Next page enqueued: ${pageNo + 1}`);
            } else {
                crawlerLog.info(`No next page found. End of results.`);
            }
            return;
        }

    if (label === 'DETAIL') {
            // Check if we should skip (in case we got more enqueued than needed)
            if (jobsScraped >= RESULTS_WANTED) {
                crawlerLog.info(`Skipping detail - already at limit: ${request.url}`);
                return;
            }

            // Robust title/company/location/date extraction with fallbacks for different Workopolis templates
            const title = (
                $('h1.job-title').first().text() ||
                $('h1').first().text() ||
                $('[data-qa="job-title"]').text() ||
                $('[itemprop="title"]').text() ||
                ''
            ).trim();

            const company = (
                $('[data-cy="company-name"]').text() ||
                $('.company, .job-company, .employer, [data-qa="company"]').first().text() ||
                $('.company-name').first().text() ||
                ''
            ).trim();

            const location = (
                $('[data-cy="location"]').text() ||
                $('.location, .job-location, [data-qa="location"]').first().text() ||
                $('meta[property="jobLocation"]')?.attr('content') ||
                ''
            ).trim();

            // Date posted: check time tags, meta tags, or text labels
            let date_posted = '';
            date_posted = date_posted || $('time[datetime]').first().attr('datetime') || '';
            date_posted = date_posted || $('meta[name="datePosted"]').attr('content') || '';
            if (!date_posted) {
                const postedText = $('*').filter((i, el) => /posted|date posted|posted on/i.test($(el).text())).first().text();
                date_posted = postedText ? postedText.trim().replace(/\s+/g, ' ') : '';
            }

            const container = findBestDescriptionContainer($);
            let description_html = sanitizeHtmlString(container?.html?.() || '');
            if (!description_html) {
                const broad = $('article, main').first().html() || $('body').html() || '';
                description_html = sanitizeHtmlString(broad);
            }

            const description_text = htmlToText(description_html);

            const item = {
                url: request.url,
                title: title || null,
                company: company || null,
                location: location || null,
                date_posted: date_posted || null,
                description_html: description_html || null,
                description_text: description_text || null,
                _source: 'workopolis.com',
                _fetchedAt: new Date().toISOString(),
                _from: 'detail',
            };
            
            // Log missing key fields for diagnostics
            if (!title) crawlerLog.warn(`Detail page missing title: ${request.url}`);
            if (!company) crawlerLog.debug(`Company not found for ${request.url}`);

            await Dataset.pushData(item);
            jobsScraped++;
            crawlerLog.info(`✓ Job ${jobsScraped}/${RESULTS_WANTED} saved: ${title || 'Untitled'}`);
        }
    },
    
    // Add failure handler for better error recovery
    failedRequestHandler: async ({ request }, error) => {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run(initialUrls.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
log.info(`✓ Scraping completed. Total jobs scraped: ${jobsScraped}/${RESULTS_WANTED} | Jobs enqueued: ${jobsEnqueued}`);

await Actor.exit();
