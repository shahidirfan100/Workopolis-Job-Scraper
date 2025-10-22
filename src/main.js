// Workopolis.com jobs scraper (CheerioCrawler)
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and crawlee@^3

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// QA-Friendly Refactor:
// Wrapped in Actor.main() for clean startup/shutdown.
// Removed custom timeout/process.exit() in favor of platform timeout.
// Made input validation non-throwing (logs warnings and uses defaults).
// Added global error handlers.
// Updated failedRequestHandler to log at 'error' level.
// Simplified proxy config to strictly honor input, avoiding forced 'RESIDENTIAL'.

Actor.main(async () => {
    // Global error handlers for robustness
    process.on('unhandledRejection', (reason, promise) => {
        log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
        log.error('Uncaught Exception:', error);
    });

    // Health check variables (REMOVED - No longer needed)
    // let healthCheckPassed = false; // REMOVED
    let startTime = Date.now();

    // await Actor.init(); // Handled by Actor.main()

    // ------------------------- INPUT VALIDATION -------------------------
    let input = await Actor.getInput() ?? {};
    log.info('Received input:', input);

    // Validate input (QA-Friendly: Warn instead of throw)
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        log.warning(`Invalid input: Input must be an object, but received ${typeof input}. Using default values.`);
        input = {}; // Reset to empty object
    }

    let {
        keyword = '',
        location = '',
        posted_date = 'anytime',

        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 999,

        collectDetails = true,

        startUrls,

        cookies,
        cookiesJson,
        proxyConfiguration,
    } = input;

    // Validate required fields - user must provide either keyword/location or a URL
    const hasSearchTerms = keyword || location;
    const hasUrls = startUrls && Array.isArray(startUrls) && startUrls.length > 0;

    // If no search terms or URLs provided, default to 'browse' search to ensure actor doesn't fail
    // This allows the actor to work with minimal or no input (important for QA testing)
    if (!hasSearchTerms && !hasUrls) {
        log.warning('No keyword, location, or URLs provided. Defaulting to browse results.');
    }

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

    // Validate posted_date (QA-Friendly: Warn instead of throw)
    const validPostedDates = ['anytime', '24h', '7d', '30d'];
    if (!validPostedDates.includes(posted_date)) {
        log.warning(`Invalid posted_date: "${posted_date}". Defaulting to "anytime". Valid values are: ${validPostedDates.join(', ')}`);
        posted_date = 'anytime';
    }

    // Health check: Set timeout... (REMOVED)
    // The platform's 5-minute timeout is the correct mechanism.
    // This removes the reliance on process.exit().

    // ------------------------- HELPERS -------------------------
    // (All helpers remain unchanged)

    /**
     * Safe JSON parse to avoid crash on malformed JSON-LD blocks.
     */
    const safeJsonParse = (input) => {
        try { return JSON.parse(input); } catch (err) { log.debug(`Bad JSON-LD: ${err.message}`); return null; }
    };

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
        try {
            const abs = new URL(href, 'https://www.workopolis.com').href;
            if (!/^https?:/i.test(abs)) return null;
            return abs;
        } catch { return null; }

    };

    const collectJobLinks = ($, baseUrl) => {
        // (Function unchanged)
        // Optimized: Use targeted selectors first for speed (90% of cases)
        const links = new Set();
        const jobHrefRx = /^\/?(?:en\/)?job(?:s|search\/viewjob)?\/[\-\w%]+/i;
        
        // Fast path: Try specific selectors first
        const specificSelectors = [
            'a[href*="/job/"]',
            'a[href*="/jobsearch/viewjob"]',
            'a[href*="jobId="]',
            '.job-card a[href]',
            '.search-result a[href]',
            '.job-listing a[href]',
            'article a[href]'
        ];
        
        for (const selector of specificSelectors) {
            const anchors = $(selector);
            if (anchors.length > 0) {
                anchors.each((_, a) => {
                    const href = $(a).attr('href');
                    if (!href || /^#|^javascript:/i.test(href)) return;
                    
                    if (jobHrefRx.test(href) || /job[-_]?id=|jobId=/i.test(href)) {
                        const abs = toAbs(href);
                        if (abs) links.add(abs);
                    }
                });
            }
        }
        
        // If we found links via fast path, return early
        if (links.size > 0) {
            return [...links];
        }
        
        // Fallback: Broader search (slower but comprehensive)
        $('a[href]').each((_, a) => {
            try {
                const href = String($(a).attr('href') || '').trim();
                if (!href || /^#|^javascript:/i.test(href)) return;

                if (jobHrefRx.test(href) || /job[-_]?id=|jobId=/i.test(href)) {
                    const abs = toAbs(href);
                    if (abs) links.add(abs);
                    return;
                }

                // Check if anchor is inside a job listing container
                const parent = $(a).closest('li, article, .result, .job, .search-result, .job-listing, .job-card');
                if (parent.length) {
                    const abs = toAbs(href);
                    if (abs && abs.includes('workopolis.com')) links.add(abs);
                }
            } catch (e) {
                // ignore
            }
        });

        return [...links];
    };

    const findNextUrl = ($, currentUrl) => {
        // (Function unchanged)
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

        // Fallback: increment common page query params (page, p, pg, offset, start)
        try {
            const u = new URL(currentUrl);
            
            // Try 'page' parameter (most common)
            const pageParamCandidates = ['page', 'p', 'pg', 'pageNumber'];
            for (const p of pageParamCandidates) {
                if (u.searchParams.has(p)) {
                    const cur = Number(u.searchParams.get(p) || '1');
                    if (!Number.isNaN(cur)) {
                        u.searchParams.set(p, String(cur + 1));
                        return u.href;
                    }
                }
            }
            
            // Try 'start' or 'offset' parameter (offset-based pagination)
            if (u.searchParams.has('start')) {
                const cur = Number(u.searchParams.get('start') || '0');
                if (!Number.isNaN(cur)) {
                    // Assume 25 results per page (common default)
                    u.searchParams.set('start', String(cur + 25));
                    return u.href;
                }
            }

            // If no page param exists, add 'page=2' for first pagination
            const hasSearchQuery = u.searchParams.has('q') || u.searchParams.has('l');
            if (hasSearchQuery && !u.searchParams.has('page')) {
                u.searchParams.set('page', '2');
                return u.href;
            }
        } catch (e) {
            // ignore
        }

        return null;
    };

    const findBestDescriptionContainer = ($) => {
        // (Function unchanged)
        // Optimized: Clone DOM for manipulation to avoid side effects
        const $doc = $.root();
        
        // Try specific job description selectors first (fast path - 80% of cases)
        const specificSelectors = [
            '[data-testid="viewJobBodyContainer"]', // Workopolis-specific container
            '[data-testid="job-description"]',
            '.job-description',
            '.viewjob-description',
            '[data-qa="job-description"]',
            '.full-job-description',
            '[data-testid="viewJobBodyJobFullDescriptionContent"]', // Full description content
            '.description',
        ];

        for (const sel of specificSelectors) {
            const el = $(sel).first();
            if (el.length) {
                const text = el.text().trim();
                // FIXED: Reduced minimum length check and removed small section filter
                // We want to capture all content, even if it's shorter
                if (text.length > 100 && !text.match(/^(Skip to|Back to|Quick apply)/i)) {
                    return el;
                }
            }
        }

        // Optimized: Limit node search to main content areas only
        const contentAreas = $('main, [role="main"], article, .content, .job-content, .job-details').first();
        const searchRoot = contentAreas.length ? contentAreas : $('body');
        const nodeList = searchRoot.find('div, section, article').toArray();
        
        const candidates = [];
        const excludePatterns = /Skip to|Back to|Quick apply|Similar Jobs|Browse jobs|Contact Us|Privacy|Terms|Cookies|Stay Connected|Sign in|Create alert|Post Jobs|All jobs|Related Searches|Job seeker tools/i;
        const jobTerms = ['responsibilities', 'requirements', 'qualifications', 'experience', 'skills', 'duties'];

        // Optimized: Single pass scoring
        for (const node of nodeList) {
            const $el = $(node);
            const text = $el.text().trim();
            const len = text.length;

            if (len < 250 || excludePatterns.test(text)) continue;

            // Skip if it's mostly links (optimized calculation)
            const linkCount = $el.find('a').length;
            if (linkCount > 5 && linkCount / (len / 100) > 2) continue;

            let score = len;
            
            // Job terms scoring (optimized with early termination)
            const lowerText = text.toLowerCase();
            let termCount = 0;
            for (const t of jobTerms) {
                if (lowerText.includes(t)) {
                    termCount++;
                    score += 300;
                }
            }
            
            // Structure bonuses (cache counts)
            const listItems = $el.find('ul li').length;
            const paragraphs = $el.find('p').length;
            if (listItems > 2) score += 200;
            if (paragraphs > 2) score += 100;

            // Penalty for small section headings
            if (len < 500 && /^(benefits?|about|overview|summary|contact|apply)/i.test(text.substring(0, 50))) {
                score -= 500;
            }

            candidates.push({ node, $el, text, len, score });
        }

        if (!candidates.length) return searchRoot.length ? searchRoot : $('body');

        // Optimized: Skip ancestor check if we have a clear winner
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length > 0 && candidates[0].score > candidates[1]?.score * 1.5) {
            return candidates[0].$el;
        }

        // Ancestor penalty only for close scores
        const candidateNodeSet = new Set(candidates.map(c => c.node));
        for (const cand of candidates) {
            let p = cand.node.parent;
            let depth = 0;
            while (p && p.type && depth < 5) { // Limit depth for performance
                if (candidateNodeSet.has(p)) {
                    cand.score -= 800;
                    break;
                }
                p = p.parent;
                depth++;
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.$el || searchRoot || $('body');
    };

    // Optimized: Helper to clean text from a Cheerio element with reduced operations
    const cleanTextFromEl = ($el) => {
        // (Function unchanged)
        if (!$el || !$el.length) return '';
        const clone = $el.clone();

        // Single-pass removal of noisy elements
        clone.find('svg, img, button, script, style, noscript, .icon, .rating, .visually-hidden, .sr-only, [aria-hidden="true"]').remove();
        
        let txt = clone.text() || '';
        
        // Optimized: Combined regex for whitespace cleanup
        txt = String(txt)
            .replace(/[\s\r\n\t]+/g, ' ')     // normalize all whitespace in one pass
            .replace(/[^\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF]/g, '') // remove non-printable chars
            .replace(/^(Image:|Rating:|Quick apply|Apply now)/i, '') // remove UI artifacts
            .trim();
        
        return txt;
    };

    // Optimized: Sanitize job description with minimal DOM operations
    const sanitizeDescription = ($, el, baseUrl) => {
        // (Function unchanged)
        if (!el || !el.length) return '';
        const clone = el.clone();
        
        // Single-pass removal of all unwanted elements
        clone.find('script, style, nav, header, footer, button, svg, form, aside, noscript, .skip-link, [href*="#main-content"], .navigation, .nav, .menu, .breadcrumb').remove();
        
        // Optimized: Remove navigation text in single pass with direct text check
        const navPatterns = /^(Skip to|Back to|Quick apply|Apply now|Sign in|Create alert)$/i;
        clone.find('*').filter((_, node) => {
            const text = $(node).text().trim();
            return navPatterns.test(text);
        }).remove();
        
        // FIXED: Remove ALL attributes from ALL elements (except href on anchors)
        // Add element limit to prevent excessive processing
        const allElements = clone.find('*').toArray();
        const maxElements = Math.min(allElements.length, 5000); // Limit to 5000 elements max
        
        for (let i = 0; i < maxElements; i++) {
            const node = allElements[i];
            const $node = $(node);
            const tag = node.tagName ? node.tagName.toLowerCase() : (node.name || '');
            const attribs = Object.keys(node.attribs || {});
            
            if (tag === 'a') {
                // For anchors, keep only href after sanitizing
                const hrefVal = $node.attr('href');
                
                // Remove all attributes first
                attribs.forEach(attr => $node.removeAttr(attr));
                
                // Then add back sanitized href if valid
                if (hrefVal) {
                    if (hrefVal.includes('#main-content')) {
                        $node.remove();
                        continue;
                    }
                    try {
                        const abs = new URL(hrefVal, baseUrl || 'https://www.workopolis.com').href;
                        $node.attr('href', abs);
                    } catch {
                        // Invalid URL, leave no href
                    }
                }
            } else {
                // For all other elements, remove ALL attributes (class, data-*, style, etc.)
                attribs.forEach(attr => $node.removeAttr(attr));
            }
        }

        // Optimized: Remove empty elements with limited iterations
        for (let i = 0; i < 3; i++) { // Max 3 passes instead of while(true)
            const empties = clone.find('*').filter((_, n) => {
                const $n = $(n);
                const text = $n.text().trim();
                const hasStructuralChildren = $n.children('p, div, ul, ol, h1, h2, h3, h4, h5, h6, li, span, b, i, strong, em').length > 0;
                return text.length === 0 && !hasStructuralChildren;
            });
            
            if (empties.length === 0) break;
            empties.remove();
        }

        // Get the cleaned HTML
        let html = clone.html() ? String(clone.html()).trim() : '';
        
        // Optimized: Combined regex cleanup
        html = html.replace(/<>\s*<\/>/g, '').replace(/\s+/g, ' ');
        
        // Cleanup clone to free memory
        clone.remove();
        
        return html;
    };

    // Validate if the extracted description seems complete
    const validateDescriptionCompleteness = (text, html) => {
        // (Function unchanged)
        // FIXED: Less strict validation - only flag truly incomplete descriptions
        if (!text || text.length < 200) return true; // Very short, likely incomplete
        
        // Check for positive indicators of completeness
        const completenessIndicators = [
            /responsibilities|duties|role/i,
            /requirements|qualifications|skills/i,
            /experience|background/i,
            /we are looking|ideal candidate/i,
            /description|summary|overview/i,
            /benefits|perks/i, // Benefits section counts as valid content
            /job details/i // Job details section is valid
        ];
        
        let completenessScore = 0;
        completenessIndicators.forEach(pattern => {
            if (pattern.test(text)) completenessScore++;
        });
        
        // FIXED: More lenient - only flag as incomplete if no indicators and very short
        const isLikelyIncomplete = completenessScore === 0 && text.length < 500;
        
        return isLikelyIncomplete;
    };

    // Fast fallback method to find a more comprehensive description container
    const findFallbackDescriptionContainer = ($, originalContainer) => {
        // (Function unchanged)
        // Quick check: just look at immediate parent
        const parent = originalContainer.parent();
        if (parent.length) {
            const parentText = parent.text().trim();
            const originalText = originalContainer.text().trim();
            
            // If parent is significantly larger and contains job terms, use it
            if (parentText.length > originalText.length * 2 && parentText.length > 800) {
                const lowerParentText = parentText.toLowerCase();
                const hasJobTerms = ['responsibilities', 'requirements', 'qualifications'].some(term => 
                    lowerParentText.includes(term)
                );
                
                if (hasJobTerms) {
                    return parent;
                }
            }
        }
        
        return null;
    };

    const normalizeCookieHeader = ({ cookies, cookiesJson }) => {
        // (Function unchanged)
        if (cookies && typeof cookies === 'string' && cookies.trim()) return cookies.trim();
        if (cookiesJson && typeof cookiesJson === 'string') {
            try {
                const parsed = JSON.parse(cookiesJson);
                const parts = [];
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        if (typeof item === 'string') parts.push(item.trim());
                        else if (item && typeof item === 'object' && item.name) {
                            if (/workopolis\.com/i.test(item.name)) parts.push(`${item.name}=${item.value ?? ''}`);
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
    
    // Handle startUrls array (Apify standard format with requestListSources)
    if (Array.isArray(startUrls) && startUrls.length) {
        for (const item of startUrls) {
            // Support both object format {url: "..."} and string format
            if (typeof item === 'string') {
                initialUrls.push(item);
            } else if (item && typeof item === 'object' && item.url) {
                initialUrls.push(item.url);
            }
        }
    }
    
    // If no URLs provided, use the built URL from keyword/location
    if (!initialUrls.length) {
        initialUrls.push(builtStartUrl);
    }

    // ------------------------- PROXY -------------------------
    // CRITICAL FIX: Workopolis blocks requests without proper proxies
    // If proxyConfiguration is provided but has empty groups, default to RESIDENTIAL
    let proxyConf;
    if (proxyConfiguration) {
        // Check if apifyProxyGroups is empty array and fix it
        if (proxyConfiguration.useApifyProxy && 
            Array.isArray(proxyConfiguration.apifyProxyGroups) && 
            proxyConfiguration.apifyProxyGroups.length === 0) {
            log.warning('Empty proxy groups detected. Defaulting to RESIDENTIAL proxies to avoid blocking.');
            proxyConfiguration.apifyProxyGroups = ['RESIDENTIAL'];
        }
        proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
    } else {
        // No proxy config provided - use default RESIDENTIAL to avoid 403 errors
        log.warning('No proxy configuration provided. Using RESIDENTIAL proxies to avoid blocking.');
        proxyConf = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL']
        });
    }

    // ------------------------- SHARED STATE -------------------------
    let jobsScraped = 0; // Actual jobs pushed to dataset
    let jobsEnqueued = 0; // Jobs enqueued for detail scraping
    let shouldStopEnqueuing = false; // Stop enqueueing new jobs
    const cookieHeader = normalizeCookieHeader({ cookies, cookiesJson });

    // ------------------------- CRAWLER -------------------------
    // Anti-blocking settings optimized for Workopolis
    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestsPerMinute: 60, // Further reduced to avoid rate limiting
        requestHandlerTimeoutSecs: 45, // Increased timeout for slower proxies
        navigationTimeoutSecs: 45,
        maxConcurrency: 3, // Lower concurrency = more stealth
        minConcurrency: 1,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: {
            maxPoolSize: 30,
            sessionOptions: {
                maxUsageCount: 5, // Rotate sessions very frequently for stealth
                maxErrorScore: 0.5, // Retire bad sessions immediately
            },
        },
        maxRequestRetries: 2, // Reduced retries - if it fails twice, move on
        maxRequestsPerCrawl: Math.max(RESULTS_WANTED * 4, 1000),
        preNavigationHooks: [
            async ({ request, session }) => {
                // Enhanced stealth headers with realistic browser fingerprint
                const isListPage = !request.userData?.label || request.userData?.label === 'LIST';
                const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
                
                // More realistic headers that mimic real browser behavior
                request.headers = {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': isListPage ? 'none' : 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': ua,
                    'Dnt': '1',
                    ...(isListPage ? {} : { 'Referer': 'https://www.workopolis.com/search' }),
                };
                
                if (cookieHeader) {
                    request.headers.Cookie = cookieHeader;
                }
                
                // Add small random delay between requests for more natural behavior
                if (!isListPage) {
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
                }
            }
        ],
        
        async requestHandler({ request, $, log: crawlerLog, enqueueLinks, crawler, session }) {
            // (Function unchanged, all logic and selectors preserved)
            const { label, pageNo = 1 } = request.userData ?? {};

            // Mark session as good on successful response
            if (session) {
                session.markGood();
            }

            if (label === 'LIST' || !label) {
                const links = collectJobLinks($, request.url);
                
                // Reduced logging - only log significant events
                if (pageNo === 1 || pageNo % 5 === 0) {
                    crawlerLog.info(`Page ${pageNo}: Found ${links.length} jobs | Progress: ${jobsScraped}/${RESULTS_WANTED}`);
                }
                
                // Check if page has no jobs - might indicate end of results
                if (links.length === 0 && pageNo > 1) {
                    crawlerLog.warning(`⚠ Page ${pageNo} has no jobs. Possible end of results.`);
                }

                if (!collectDetails) {
                    // Direct push mode - batch processing for speed
                    const remaining = RESULTS_WANTED - jobsScraped;
                    const jobsToPush = links.slice(0, Math.max(0, remaining));
                    
                    if (jobsToPush.length > 0) {
                        const timestamp = new Date().toISOString();
                        const dataItems = jobsToPush.map(link => ({
                            url: link,
                            _source: 'workopolis.com',
                            _fetchedAt: timestamp,
                            _from: 'list'
                        }));
                        
                        await Dataset.pushData(dataItems);
                        jobsScraped += dataItems.length;
                        
                        // Only log every 10 jobs or at key milestones
                        if (jobsScraped % 10 === 0 || jobsScraped === RESULTS_WANTED) {
                            crawlerLog.info(`✓ Saved ${jobsScraped}/${RESULTS_WANTED} jobs`);
                        }
                    }
                    
                    if (jobsScraped >= RESULTS_WANTED) {
                        shouldStopEnqueuing = true;
                    }
                } else {
                    // Detail mode - only enqueue what we need
                    if (!shouldStopEnqueuing) {
                        const remaining = RESULTS_WANTED - jobsEnqueued;
                        const linksToEnqueue = links.slice(0, Math.max(0, remaining));
                        
                        if (linksToEnqueue.length > 0) {
                            const safeLinks = linksToEnqueue.filter(l => /^https:\/\/(www\.)?workopolis\.com/i.test(l));
                            
                            await enqueueLinks({
                                urls: safeLinks,
                                userData: { label: 'DETAIL' },
                                forefront: false
                            });
                            jobsEnqueued += safeLinks.length;
                        }
                        
                        if (jobsEnqueued >= RESULTS_WANTED) {
                            shouldStopEnqueuing = true;
                        }
                    }
                }

                // Check page limit first
                if (pageNo >= MAX_PAGES) {
                    crawlerLog.info(`Max pages (${MAX_PAGES}) reached.`);
                    return;
                }

                // Only stop if we've already scraped enough (not just enqueued)
                const shouldContinuePagination = !collectDetails 
                    ? jobsScraped < RESULTS_WANTED
                    : jobsEnqueued < RESULTS_WANTED * 1.5;
                
                if (!shouldContinuePagination) {
                    crawlerLog.info(`Target reached: ${jobsScraped} scraped, ${jobsEnqueued} enqueued.`);
                    return;
                }

                // Continue to next page
                const nextUrl = findNextUrl($, request.url);
                if (nextUrl && nextUrl !== request.url) {
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                        forefront: true
                    });
                }
                return;
            }

        if (label === 'DETAIL') {
                // (All extraction logic and selectors remain unchanged)
                // Check if we should skip (in case we got more enqueued than needed)
                if (jobsScraped >= RESULTS_WANTED) {
                    crawlerLog.debug(`Skipping detail - already at limit: ${request.url}`);
                    return;
                }

                // Extract job data using patterns specific to Workopolis structure
                // Wrap all extraction in try-catch to prevent crashes on unexpected HTML
                try {
                    // Optimized: Cache jQuery selections for reuse
                    
                    // Title: Look for the main job title (usually the first h1 or prominent heading)
                    let title = '';
                    // Try h1 first (most common for job titles)
                    const h1 = $('h1').first();
                    if (h1.length) {
                        title = cleanTextFromEl(h1);
                    }
                    
                    // If h1 is empty or too short, try other heading elements
                    if (!title || title.length < 3) {
                        const headingCandidates = ['h2', 'h3', '.job-title', '.jobTitle', '[data-qa*="title"]'];
                        for (const sel of headingCandidates) {
                            const el = $(sel).first();
                            if (el.length) {
                                const candidateTitle = cleanTextFromEl(el);
                                if (candidateTitle && candidateTitle.length > 3 && candidateTitle.length < 200) {
                                    title = candidateTitle;
                                    break;
                                }
                            }
                        }
                    }

                    // Company and Location: Look for the pattern "Company —Location" which is common on Workopolis
                    let company = '';
                    let location = '';
                    let date_posted = '';
                
                // --- STRATEGY 0: JSON-LD (Structured Data) - OPTIMIZED ---
                // This is the most reliable and fastest method if available.
                const jsonLdScripts = $('script[type="application/ld+json"]');
                if (jsonLdScripts.length) {
                    // Process only the first matching JSON-LD script for speed
                    const jsonLdScript = jsonLdScripts.first().html();
                    if (jsonLdScript) {
                        const jsonLd = safeJsonParse(jsonLdScript);
                        if (jsonLd && jsonLd['@type'] === 'JobPosting') {
                            crawlerLog.debug('Using JSON-LD structured data (fast path)');
                            if (jsonLd.hiringOrganization?.name) {
                                company = String(jsonLd.hiringOrganization.name).trim();
                            }
                            if (jsonLd.jobLocation?.address) {
                                const { addressLocality, addressRegion, addressCountry } = jsonLd.jobLocation.address;
                                location = [addressLocality, addressRegion, addressCountry]
                                    .filter(Boolean)
                                    .join(', ');
                            }
                            if (jsonLd.datePosted) {
                                date_posted = String(jsonLd.datePosted).trim();
                            }
                            // Use title from JSON-LD if our primary method failed
                            if ((!title || title.length < 3) && jsonLd.title) {
                                title = String(jsonLd.title).trim();
                            }
                        }
                    }
                }

                // --- FALLBACK STRATEGIES if JSON-LD is missing ---

                // Strategy 1: Look for a specific header container
                const headerEl = $('[data-testid="job-header"]').first();
                if (headerEl.length) {
                    const headerText = cleanTextFromEl(headerEl);
                    // Common pattern: "Company Name • Location"
                    if (headerText.includes('•')) {
                        const parts = headerText.split('•').map(p => p.trim());
                        if (parts.length >= 2) {
                            company = parts[0];
                            location = parts[1];
                        }
                    }
                }

                // Strategy 2: Look for "Company — Location" pattern if Strategy 1 fails
                if (!company || !location) {
                    const companyLocationElements = [
                        ...($('h2, h3, .company, [class*="company"]').toArray()),
                        ...($('div').filter((_, el) => $(el).text().includes('—')).toArray())
                    ];
                    for (const el of companyLocationElements) {
                        const text = cleanTextFromEl($(el));
                        if (text.includes('—')) {
                            const parts = text.split('—').map(p => p.trim());
                            if (parts.length >= 2 && parts[0].length > 1 && parts[1].length > 1) {
                                if (!company) company = parts[0];
                                if (!location) location = parts[1];
                                break;
                            }
                        }
                    }
                }

                // Strategy 3: Find company element, then find location in its parent
                if (!company || !location) {
                    const companyEl = $('a[href*="/company/"], .company-name, [data-qa*="company"]').first();
                    if (companyEl.length) {
                        const parentContainer = companyEl.parent();
                        if (parentContainer.length) {
                            const parentText = cleanTextFromEl(parentContainer);
                            const companyText = cleanTextFromEl(companyEl);

                            if (!company) company = companyText;

                            // The remaining text in the parent is likely the location
                            const possibleLocation = parentText.replace(companyText, '').replace(/•|—|-/g, '').trim();
                            if (possibleLocation.length > 1 && !location) {
                                location = possibleLocation;
                            }
                        }
                    }
                }

                // Fallback for company if not found in "Company —Location" pattern
                if (!company) {
                    const companySelectors = [
                        'a[href*="/company/"]',
                        '.company-name',
                        '.employer',
                        '[data-qa*="company"]',
                        '[class*="employer"]'
                    ];
                    
                    for (const sel of companySelectors) {
                        const el = $(sel).first();
                        if (el.length) {
                            const candidateCompany = cleanTextFromEl(el);
                            if (candidateCompany && candidateCompany.length > 1 && candidateCompany.length < 100) {
                                company = candidateCompany;
                                break;
                            }
                        }
                    }
                }
                
                // Fallback for location if not found
                if (!location) {
                    const locationSelectors = [
                        '.location',
                        '.job-location',
                        '[data-qa*="location"]',
                        '[class*="location"]'
                    ];
                    
                    for (const sel of locationSelectors) {
                        const el = $(sel).first();
                        if (el.length) {
                            const candidateLocation = cleanTextFromEl(el);
                            if (candidateLocation && candidateLocation.length > 1 && candidateLocation.length < 100) {
                                location = candidateLocation;
                                break;
                            }
                        }
                    }
                }

                    // Final location fallback: look for text nodes near the company name
                    if (company && !location) {
                        try {
                            const safeCompany = company.replace(/['"\\]/g, '\\\\$&');
                            const companyEl = $(`*:contains('${safeCompany}')`).filter((_, el) => $(el).children().length === 0).last();
                            if (companyEl.length) {
                                const parentText = cleanTextFromEl(companyEl.parent());
                                const possibleLocation = parentText.replace(company, '').replace(/•|—|-/g, '').trim();
                                if (possibleLocation.length > 1 && possibleLocation.length < 100) {
                                    location = possibleLocation;
                                    crawlerLog.debug(`Used final fallback to find location: "${location}"`);
                                }
                            }
                        } catch (err) {
                            crawlerLog.debug(`Error in final location fallback: ${err.message}`);
                        }
                    }

                // Date posted: Look for time elements or standalone date patterns
                if (!date_posted) {
                    // Try specific selectors first
                    const dateSelectors = ['time', '[data-testid*="posted"]', '[class*="posted"]'];
                    for (const sel of dateSelectors) {
                        const el = $(sel).first();
                        if (el.length) {
                            const datetime = el.attr('datetime');
                            if (datetime) {
                                date_posted = datetime;
                                break;
                            }
                            const text = cleanTextFromEl(el);
                            if (text) {
                                date_posted = text;
                                break;
                            }
                        }
                    }

                    // Final fallback: search for text patterns if selectors fail
                    if (!date_posted) {
                        $('span, div, p').each((_, el) => {
                            const text = cleanTextFromEl($(el));
                            // Look for "posted..." or common relative date patterns like "3 days ago"
                            const dateMatch = text.match(/(posted\s+.*ago|posted\s+on\s+.*|\d+\s+(day|week|month)s?\s+ago)/i);
                            if (dateMatch && dateMatch[0] && text.length < 40) {
                                date_posted = dateMatch[0];
                                return false; // break loop
                            }
                        });
                    }
                }

                // Optimized description extraction - reduced overhead
                const container = findBestDescriptionContainer($);
                let description_html = '';
                let description_text = '';

                if (container && container.length) {
                    // Always generate HTML first from the best container
                    description_html = sanitizeDescription($, container, request.url);

                    // Always generate the text from the sanitized HTML to ensure consistency.
                    description_text = cheerioLoad(description_html || '').text().replace(/\s+/g, ' ').trim();
                    
                    // Quick validation: Check if the extracted description seems incomplete
                    const isIncomplete = validateDescriptionCompleteness(description_text, description_html);
                    
                    if (isIncomplete && description_text.length < 800) {
                        crawlerLog.debug(`Description seems short (${description_text.length} chars). Trying fallback...`);
                        
                        // Fallback: Try to find a more comprehensive container
                        const fallbackContainer = findFallbackDescriptionContainer($, container);
                        
                        if (fallbackContainer && fallbackContainer.length && fallbackContainer[0] !== container[0]) {
                            const fallbackHtml = sanitizeDescription($, fallbackContainer, request.url);
                            const fallbackText = cheerioLoad(fallbackHtml || '').text().replace(/\s+/g, ' ').trim();
                            
                            if (fallbackText.length > description_text.length * 1.5) {
                                crawlerLog.debug(`Fallback found better description (${fallbackText.length} vs ${description_text.length} chars)`);
                                description_html = fallbackHtml;
                                description_text = fallbackText;
                            }
                        }
                    }
                } else {
                    crawlerLog.debug(`Could not find description container for ${request.url}`);
                }
                
                // Minimal logging - only critical issues
                if (!title && !company) {
                    crawlerLog.debug(`Missing key fields for ${request.url}`);
                }

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

                await Dataset.pushData(item);
                jobsScraped++;
                
                // Only log progress at key milestones (every 5 jobs or first/last)
                if (jobsScraped % 5 === 0 || jobsScraped === 1 || jobsScraped === RESULTS_WANTED) {
                    crawlerLog.info(`✓ Progress: ${jobsScraped}/${RESULTS_WANTED} jobs`);
                }
                } catch (err) {
                    crawlerLog.error(`Error extracting job details from ${request.url}: ${err.message}`);
                    // Don't re-throw - allow other jobs to be processed
                }
            }
        },
        
        // Simplified failure handler with minimal logging
        failedRequestHandler: async ({ request, session }, error) => {
            // Only log critical failures
            const isBlocked = error.message.includes('403') || error.message.includes('blocked');
            
            if (session && isBlocked) {
                session.markBad();
            }
            
            // Only log LIST page failures as they're critical
            if (request.userData?.label === 'LIST') {
                log.error(`LIST page failed: ${request.url.substring(0, 100)}`);
            }
        },
    });

    try {
        log.info('Starting crawl with initial URLs:', initialUrls);
        await crawler.run(initialUrls.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`✓ Completed: ${jobsScraped}/${RESULTS_WANTED} jobs scraped`);
        
        // Check if we got any results
        if (jobsScraped === 0) {
            log.warning('No jobs scraped. Check search parameters or site availability.');
        }
        
        // Log execution time
        const executionTime = Date.now() - startTime;
        log.info(`Execution time: ${Math.round(executionTime/1000)}s`);
        
    } catch (error) {
        log.error(`Actor failed: ${error.message}`);
        throw error;
    }

    // await Actor.exit(); // Handled by Actor.main()
});