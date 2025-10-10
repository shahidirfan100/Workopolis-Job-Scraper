// Workopolis.com jobs scraper (CheerioCrawler)
// Runtime: Node 22, ESM ("type": "module")
// Uses apify@^3 and crawlee@^3

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

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
    // Workopolis uses paths like /jobsearch/viewjob/<id> as well as /job/... in some templates
    const jobHrefRx = /\/jobsearch\/viewjob\/(?:[-_a-zA-Z0-9%_]+)|\/job(\/|[-_a-zA-Z0-9?=&%]+)|\/(?:en\/)?job[s]?[-_a-zA-Z0-9]*/i;

    anchorCandidates.forEach((i, a) => {
        try {
            const href = String($(a).attr('href') || '').trim();
            if (!href) return;
            // ignore anchors that are page anchors or javascript
            if (/^#|^javascript:/i.test(href)) return;

            // If href contains 'job' token it's likely a detail link
            if (jobHrefRx.test(href) || /job[-_]?id=|jobId=/i.test(href)) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs) links.add(abs);
                return;
            }

            // Heuristic: anchors inside listing items
            const parent = $(a).closest('li, article, .result, .job, .search-result, .job-listing, .job-card, .searchCard');
            if (parent && parent.length) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs && abs.includes('workopolis.com')) links.add(abs);
            }
        } catch (e) {
            // ignore
        }
    });

    // Fallback: if no links detected, try anchors containing known jobsearch path
    if (!links.size) {
        $('a[href]').each((_, a) => {
            const href = String($(a).attr('href') || '').trim();
            if (!href) return;
            if (href.includes('/jobsearch/viewjob')) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs) links.add(abs);
            }
        });
    }

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
    // Remove skip links and navigation first
    $('a[href*="#main-content"], .skip-link, nav, header, footer').remove();

    // Try specific job description selectors first (fast path)
    const specificSelectors = [
        '[data-testid="job-description"]',
        '.job-description',
        '.viewjob-description',
        '[data-qa="job-description"]',
        '.full-job-description',
        '.description',
    ];

    for (const sel of specificSelectors) {
        const el = $(sel).first();
        if (el && el.length) {
            const text = el.text().trim();
            if (text.length > 300 && !text.match(/^(Skip to|Back to|Quick apply)/i)) {
                const isSmallSection = text.length < 800 && /^(benefits?|about|overview|summary)/i.test(text.substring(0, 50));
                if (!isSmallSection) return el;
            }
        }
    }

    // Build a cached list of candidate nodes to avoid repeated DOM traversals
    const nodeList = $('div, section, article, main').toArray();
    const candidates = [];
    const excludePatterns = /Skip to|Back to|Quick apply|Similar Jobs|Browse jobs|Contact Us|Privacy|Terms|Cookies|Stay Connected|Sign in|Create alert|Post Jobs|All jobs|Related Searches|Job seeker tools/i;

    for (const node of nodeList) {
        const $el = $(node);
        const text = $el.text().trim();
        const len = text.length;

        if (len < 250 || excludePatterns.test(text)) continue;

        // Skip if it's mostly links
        const linkRatio = $el.find('a').length / Math.max(1, text.split(' ').length / 15);
        if (linkRatio > 0.25) continue;

        candidates.push({ node, $el, text, len, score: len });
    }

    if (!candidates.length) return $('main').first() || $('body');

    // Precompute job-term boosts and structure bonuses
    const jobTerms = ['responsibilities', 'requirements', 'qualifications', 'experience', 'skills', 'duties'];
    for (const cand of candidates) {
        const lowerText = cand.text.toLowerCase();
        let termCount = 0;
        for (const t of jobTerms) {
            if (lowerText.includes(t)) termCount++;
        }
        if (termCount) cand.score += termCount * 300;
        if (cand.$el.find('ul li').length > 2) cand.score += 200;
        if (cand.$el.find('p').length > 2) cand.score += 100;

        // Penalty for small section headings
        if (cand.len < 500 && /^(benefits?|about|overview|summary|contact|apply)/i.test(cand.text.substring(0, 50))) {
            cand.score -= 500;
        }
    }

    // Create a Set for quick ancestor checks
    const candidateNodeSet = new Set(candidates.map(c => c.node));

    // For each candidate, determine if it has an ancestor candidate; penalize children
    for (const cand of candidates) {
        let p = cand.node.parent;
        while (p && p.type) {
            if (candidateNodeSet.has(p)) {
                // found an ancestor candidate
                cand.score -= 800;
                break;
            }
            p = p.parent;
        }
    }

    // Pick the candidate with the highest score
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return (best && best.$el) || $('main').first() || $('body');
};

// Helper to clean text from a Cheerio element: remove icons/images/buttons before reading text
const cleanTextFromEl = ($el) => {
    if (!$el || !$el.length) return '';
    const clone = $el.clone();

    // Remove noisy inner elements that pollute text
    clone.find('svg, img, button, script, style, noscript, .icon, .rating, .visually-hidden, .sr-only, [aria-hidden="true"]').remove();
    
    let txt = clone.text() || '';
    
    // Clean up whitespace and common artifacts
    txt = String(txt)
        .replace(/\s+/g, ' ')           // normalize whitespace
        .replace(/[\r\n\t]+/g, ' ')     // remove line breaks and tabs
        .replace(/[^\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF]/g, '') // remove non-printable chars but keep accented
        .trim();
        
    // Remove common UI artifacts
    txt = txt.replace(/^(Image:|Rating:|Quick apply|Apply now)/i, '').trim();
    
    return txt;
};

// Sanitize job description using the existing Cheerio instance to preserve structure and links
const sanitizeDescription = ($, el, baseUrl) => {
    if (!el || !el.length) return '';
    const clone = el.clone();
    
    // Remove unwanted elements entirely
    clone.find('script, style, nav, header, footer, button, svg, form, aside, noscript').remove();
    clone.find('.skip-link, [href*="#main-content"]').remove();
    clone.find('.navigation, .nav, .menu, .breadcrumb').remove();
    
    // Remove elements with navigation-like text
    clone.find('*').each((_, node) => {
        const $node = $(node);
        const text = $node.text().trim();
        if (text.match(/^(Skip to|Back to|Quick apply|Apply now|Sign in|Create alert)$/i)) {
            $node.remove();
        }
    });
    
    // Clean up attributes on remaining elements
    clone.find('*').each((_, node) => {
        const tag = node.tagName ? node.tagName.toLowerCase() : (node.name || '');
        const attribs = Object.keys(node.attribs || {});
        
        for (const attr of attribs) {
            // Keep href on anchors but sanitize them
            if (tag === 'a' && attr === 'href') {
                const hrefVal = $(node).attr('href');
                try {
                    // Skip internal navigation links
                    if (hrefVal && hrefVal.includes('#main-content')) {
                        $(node).remove();
                        return;
                    }
                    const abs = new URL(hrefVal, baseUrl || 'https://www.workopolis.com').href;
                    $(node).attr('href', abs);
                } catch {
                    $(node).removeAttr('href');
                }
                continue;
            }
            
            // Keep essential structure attributes for lists and headings
            if ((tag === 'ul' || tag === 'ol') && attr === 'type') continue;
            if ((tag.match(/^h[1-6]$/)) && attr === 'id') continue;
            
            // Remove all other attributes
            $(node).removeAttr(attr);
        }
    });

    // Remove empty elements recursively
    let removedSomething = true;
    while (removedSomething) {
        removedSomething = false;
        clone.find('*').each((_, n) => {
            const $n = $(n);
            const text = $n.text().trim();
            const hasContent = text.length > 0;
            const hasStructuralChildren = $n.children('p, div, ul, ol, h1, h2, h3, h4, h5, h6, li').length > 0;
            
            if (!hasContent && !hasStructuralChildren) {
                $n.remove();
                removedSomething = true;
            }
        });
    }

    // Get the cleaned HTML
    let html = clone.html() ? String(clone.html()).trim() : '';
    
    // Final cleanup of the HTML string
    html = html.replace(/<>\s*<\/>/g, ''); // Remove empty tags
    html = html.replace(/\s+/g, ' '); // Normalize whitespace
    
    return html;
};

// Validate if the extracted description seems complete
const validateDescriptionCompleteness = (text, html) => {
    if (!text || text.length < 300) return true; // Definitely incomplete
    
    // Check for positive indicators of completeness
    const completenessIndicators = [
        /responsibilities|duties|role/i,
        /requirements|qualifications|skills/i,
        /experience|background/i,
        /we are looking|ideal candidate/i,
        /description|summary|overview/i
    ];
    
    let completenessScore = 0;
    completenessIndicators.forEach(pattern => {
        if (pattern.test(text)) completenessScore++;
    });
    
    // If we have less than 2 completeness indicators and the text is short, it's likely incomplete
    const isLikelyIncomplete = completenessScore < 2 && text.length < 800;
    
    // Check if it looks like just a "Benefits" section
    const isBenefitsOnly = /^.*benefits?.*$/i.test(text.substring(0, 100)) && 
                          text.length < 1000 && 
                          !text.toLowerCase().includes('responsibilities');
    
    // Quick check if HTML suggests it's a small section
    const htmlSectionCheck = html && html.includes('<h') && text.length < 1200;
    
    return isLikelyIncomplete || isBenefitsOnly || htmlSectionCheck;
};

// Fast fallback method to find a more comprehensive description container
const findFallbackDescriptionContainer = ($, originalContainer) => {
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
            if (links.length) {
                const sample = links.slice(0, 6).join('\n - ');
                crawlerLog.debug(`Sample links:\n - ${sample}`);
            } else {
                crawlerLog.debug('No candidate links found on this list page (links.length === 0)');
            }

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

            // Extract job data using patterns specific to Workopolis structure
            
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
            
            // --- STRATEGY 0: JSON-LD (Structured Data) ---
            // This is the most reliable method if available.
            const jsonLdScript = $('script[type="application/ld+json"]').first().html();
            if (jsonLdScript) {
                try {
                    const jsonLd = JSON.parse(jsonLdScript);
                    if (jsonLd['@type'] === 'JobPosting') {
                        crawlerLog.info('Found JSON-LD data. Using it for extraction.');
                        if (jsonLd.hiringOrganization && jsonLd.hiringOrganization.name) {
                            company = String(jsonLd.hiringOrganization.name).trim();
                        }
                        if (jsonLd.jobLocation && jsonLd.jobLocation.address) {
                            const { addressLocality, addressRegion, addressCountry } = jsonLd.jobLocation.address;
                            location = [addressLocality, addressRegion, addressCountry]
                                .filter(Boolean) // Remove empty parts
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
                } catch (e) {
                    crawlerLog.debug(`Could not parse JSON-LD: ${e.message}`);
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
                const companyEl = $(`*:contains('${company}')`).filter((_, el) => $(el).children().length === 0).last();
                if (companyEl.length) {
                    const parentText = cleanTextFromEl(companyEl.parent());
                    const possibleLocation = parentText.replace(company, '').replace(/•|—|-/g, '').trim();
                    if (possibleLocation.length > 1 && possibleLocation.length < 100) {
                        location = possibleLocation;
                        crawlerLog.debug(`Used final fallback to find location: "${location}"`);
                    }
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
                    crawlerLog.info(`⚠️ WARN: Description seems incomplete (${description_text.length} chars). Trying fallback method...`);
                    
                    // Fallback: Try to find a more comprehensive container
                    const fallbackContainer = findFallbackDescriptionContainer($, container);
                    
                    if (fallbackContainer && fallbackContainer.length && fallbackContainer[0] !== container[0]) {
                        const fallbackHtml = sanitizeDescription($, fallbackContainer, request.url);
                        const fallbackText = cheerioLoad(fallbackHtml || '').text().replace(/\s+/g, ' ').trim();
                        
                        if (fallbackText.length > description_text.length * 1.5) {
                            crawlerLog.info(`Fallback found better description (${fallbackText.length} vs ${description_text.length} chars)`);
                            description_html = fallbackHtml;
                            description_text = fallbackText;
                        }
                    }
                }
            } else {
                crawlerLog.info(`⚠️ WARN: Could not find a suitable description container for ${request.url}`);
            }
            
            // Log extraction results for debugging
            crawlerLog.info(`Extracted from ${request.url}:`);
            crawlerLog.info(`  Title: ${title || 'MISSING'}`);
            crawlerLog.info(`  Company: ${company || 'MISSING'}`);
            crawlerLog.info(`  Location: ${location || 'MISSING'}`);
            crawlerLog.info(`  Date: ${date_posted || 'MISSING'}`);
            crawlerLog.info(`  Description length: ${description_text ? description_text.length : 0} chars`);
            
            // Basic debugging for description extraction
            if (description_text && description_text.length > 0) {
                crawlerLog.debug(`  Description preview: ${description_text.substring(0, 150)}...`);
                
                // Only log if description seems problematic
                if (description_text.length < 400) {
                    crawlerLog.info(`⚠️ WARN: Short description (${description_text.length} chars)`);
                }
            }

            const item = {
                url: request.url,
                title: title && title.length ? title : null,
                company: company && company.length ? company : null,
                location: location && location.length ? location : null,
                date_posted: date_posted && date_posted.length ? date_posted : null,
                description_html: description_html && description_html.length ? description_html : null,
                description_text: description_text && description_text.length ? description_text : null,
                _source: 'workopolis.com',
                _fetchedAt: new Date().toISOString(),
                _from: 'detail',
            };
            
            // Log missing key fields for diagnostics
            if (!title) crawlerLog.info(`⚠️ WARN: Detail page missing title: ${request.url}`);
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
