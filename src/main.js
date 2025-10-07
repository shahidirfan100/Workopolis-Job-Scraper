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
    const url = new URL('https://www.workopolis.com/search');
    url.searchParams.set('q', kw && String(kw).trim() ? String(kw).trim() : 'browse');
    if (loc && String(loc).trim()) url.searchParams.set('l', String(loc).trim());
    if (date && date !== 'anytime') url.searchParams.set('posted', String(date));
    return url.href;
};

const toAbs = (href) => {
    try { return new URL(href, 'https://www.workopolis.com').href; } catch { return null; }
};

const collectJobLinks = ($, baseUrl) => {
    const links = new Set();
    const anchorCandidates = [];
    anchorCandidates.push(...$('a[href]'));

    const jobHrefRx = /\/jobsearch\/viewjob\/(?:[-_a-zA-Z0-9%_]+)|\/job(\/|[-_a-zA-Z0-9?=&%]+)|\/(?:en\/)?job[s]?[-_a-zA-Z0-9]*/i;

    anchorCandidates.forEach((i, a) => {
        try {
            const href = String($(a).attr('href') || '').trim();
            if (!href) return;
            if (/^#|^javascript:/i.test(href)) return;

            if (jobHrefRx.test(href) || /job[-_]?id=|jobId=/i.test(href)) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs) links.add(abs);
                return;
            }

            const parent = $(a).closest('li, article, .result, .job, .search-result, .job-listing, .job-card, .searchCard');
            if (parent && parent.length) {
                const abs = toAbs(href) || (baseUrl ? new URL(href, baseUrl).href : null);
                if (abs && abs.includes('workopolis.com')) links.add(abs);
            }
        } catch (e) {
            // ignore
        }
    });

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

    return [...links].filter(Boolean);
};

const findNextUrl = ($, currentUrl) => {
    const relNext = $('a[rel="next"]').attr('href');
    if (relNext) return toAbs(relNext) || null;

    const ariaNext = $('a[aria-label*="next" i], button[aria-label*="next" i]').first().attr('href');
    if (ariaNext) return toAbs(ariaNext) || null;

    const nextByText = $('a, button').filter((_, el) => /next|›|»/i.test($(el).text())).first().attr('href');
    if (nextByText) return toAbs(nextByText) || null;

    const active = $('.pagination .active, .pagination li.active, .pagination li.current').first();
    if (active && active.length) {
        const next = active.next('li').find('a').attr('href');
        if (next) return toAbs(next) || null;
    }

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

        if (![...u.searchParams.keys()].length) {
            u.searchParams.set('page', '2');
            return u.href;
        }
    } catch (e) {
        // ignore
    }

    return null;
};

// FIXED: Work on a clone to avoid modifying the original $ object
const findBestDescriptionContainer = ($) => {
    // Create a clone to avoid modifying the original DOM
    const $clone = cheerioLoad($.html());
    
    // Remove skip links and navigation from the clone
    $clone('a[href*="#main-content"], .skip-link, nav, header, footer').remove();
    
    // Try specific job description selectors first
    const specificSelectors = [
        '[data-testid="job-description"]',
        '.job-description',
        '.viewjob-description',
        '[data-qa="job-description"]',
        '.full-job-description',
        '.description',
    ];

    for (const sel of specificSelectors) {
        const el = $clone(sel).first();
        if (el && el.length) {
            const text = el.text().trim();
            if (text.length > 100 && !text.match(/^(Skip to|Back to|Quick apply)/i)) {
                // Return the selector, not the element, so we can find it in the original $
                return { selector: sel, $original: $ };
            }
        }
    }

    // Fallback: find the largest text block in the clone
    let best = null;
    let bestScore = 0;
    
    const excludePatterns = /Skip to|Back to|Quick apply|Similar Jobs|Browse jobs|Contact Us|Privacy|Terms|Cookies|Stay Connected|Sign in|Create alert|Post Jobs|All jobs|Related Searches|Job seeker tools/i;
    
    $clone('div, section, article').each((_, el) => {
        const $el = $clone(el);
        const text = $el.text().trim();
        const len = text.length;

        if (len < 200 || excludePatterns.test(text)) return;

        const linkRatio = $el.find('a').length / Math.max(1, text.split(' ').length / 10);
        if (linkRatio > 0.3) return;

        const dateMatches = text.match(/\b20\d{2}\b/g);
        if (dateMatches && dateMatches.length > 3) return;
        
        let score = len;
        
        const jobTerms = [
            'responsibilities', 'requirements', 'qualifications', 'experience',
            'skills', 'duties', 'role', 'position', 'candidate', 'applicant',
            'salary', 'benefits', 'team', 'company', 'work', 'job'
        ];

        const lowerText = text.toLowerCase();
        jobTerms.forEach(term => {
            if (lowerText.includes(term)) score += 50;
        });

        if ($el.find('ul li').length > 1) score += 100;
        if ($el.find('p').length > 2) score += 50;
        if ($el.find('h2, h3, h4').length > 0) score += 25;

        const firstHeading = $el.find('h2, h3').first().text().trim().toLowerCase();
        if (len < 500 && (firstHeading === 'benefits' || firstHeading === 'about the company')) {
            score -= 150;
        }

        const words = text.split(' ');
        const uniqueWords = new Set(words);
        if (uniqueWords.size < words.length * 0.3) score -= 100;
        
        if (score > bestScore) {
            bestScore = score;
            best = $el;
        }
    });

    // Return null if no container found, we'll use fallback in the handler
    if (!best || !best.length) return null;
    
    // Try to find a unique selector for this element in the original DOM
    const tagName = best[0].tagName || best[0].name || 'div';
    const classes = best.attr('class');
    
    if (classes) {
        const classSelector = `.${classes.split(' ').join('.')}`;
        const matching = $(classSelector);
        if (matching.length === 1) {
            return { selector: classSelector, $original: $ };
        }
    }
    
    // Fallback to main or body
    return { selector: 'main', $original: $ };
};

// Helper to clean text from a Cheerio element
const cleanTextFromEl = ($el) => {
    if (!$el || !$el.length) return '';
    const clone = $el.clone();

    clone.find('svg, img, button, script, style, noscript, .icon, .rating, .visually-hidden, .sr-only, [aria-hidden="true"]').remove();
    
    let txt = clone.text() || '';
    
    txt = String(txt)
        .replace(/\s+/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF]/g, '')
        .trim();
        
    txt = txt.replace(/^(Image:|Rating:|Quick apply|Apply now)/i, '').trim();
    
    return txt;
};

// FIXED: Sanitize description with better error handling
const sanitizeDescription = ($, el, baseUrl) => {
    if (!el || !el.length) return '';
    
    try {
        const clone = el.clone();
        
        clone.find('script, style, nav, header, footer, button, svg, form, aside, noscript').remove();
        clone.find('.skip-link, [href*="#main-content"]').remove();
        clone.find('.navigation, .nav, .menu, .breadcrumb').remove();
        
        clone.find('*').each((_, node) => {
            const $node = $(node);
            const text = $node.text().trim();
            if (text.match(/^(Skip to|Back to|Quick apply|Apply now|Sign in|Create alert)$/i)) {
                $node.remove();
            }
        });
        
        clone.find('*').each((_, node) => {
            const tag = node.tagName ? node.tagName.toLowerCase() : (node.name || '');
            const attribs = Object.keys(node.attribs || {});
            
            for (const attr of attribs) {
                if (tag === 'a' && attr === 'href') {
                    const hrefVal = $(node).attr('href');
                    try {
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
                
                if ((tag === 'ul' || tag === 'ol') && attr === 'type') continue;
                if ((tag.match(/^h[1-6]$/)) && attr === 'id') continue;
                
                $(node).removeAttr(attr);
            }
        });

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

        let html = clone.html() ? String(clone.html()).trim() : '';
        
        html = html.replace(/<>\s*<\/>/g, '');
        html = html.replace(/\s+/g, ' ');
        
        return html;
    } catch (error) {
        log.error(`Error sanitizing description: ${error.message}`);
        return '';
    }
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
let jobsScraped = 0;
let jobsEnqueued = 0;
let shouldStopEnqueuing = false;
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
                    
                    if (jobsEnqueued >= RESULTS_WANTED) {
                        shouldStopEnqueuing = true;
                        crawlerLog.info(`✓ Reached target: ${jobsEnqueued} jobs enqueued. Stopping pagination.`);
                        return;
                    }
                }
            }

            if (shouldStopEnqueuing || jobsScraped >= RESULTS_WANTED) {
                crawlerLog.info(`Stopping pagination. Scraped: ${jobsScraped}, Enqueued: ${jobsEnqueued}`);
                return;
            }

            if (pageNo >= MAX_PAGES) {
                crawlerLog.info(`Max pages (${MAX_PAGES}) reached. Stopping pagination.`);
                return;
            }

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
            if (jobsScraped >= RESULTS_WANTED) {
                crawlerLog.info(`Skipping detail - already at limit: ${request.url}`);
                return;
            }

            // Extract job data
            let title = '';
            const h1 = $('h1').first();
            if (h1.length) {
                title = cleanTextFromEl(h1);
            }
            
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

            let company = '';
            let location = '';
            let date_posted = '';
            
            // JSON-LD extraction
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
                                .filter(Boolean)
                                .join(', ');
                        }
                        if (jsonLd.datePosted) {
                            date_posted = String(jsonLd.datePosted).trim();
                        }
                        if ((!title || title.length < 3) && jsonLd.title) {
                            title = String(jsonLd.title).trim();
                        }
                    }
                } catch (e) {
                    crawlerLog.debug(`Could not parse JSON-LD: ${e.message}`);
                }
            }

            // Fallback strategies for company and location
            if (!company || !location) {
                const headerEl = $('[data-testid="job-header"]').first();
                if (headerEl.length) {
                    const headerText = cleanTextFromEl(headerEl);
                    if (headerText.includes('•')) {
                        const parts = headerText.split('•').map(p => p.trim());
                        if (parts.length >= 2) {
                            company = parts[0];
                            location = parts[1];
                        }
                    }
                }
            }

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

            // Date posted extraction
            if (!date_posted) {
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

                if (!date_posted) {
                    $('span, div, p').each((_, el) => {
                        const text = cleanTextFromEl($(el));
                        const dateMatch = text.match(/(posted\s+.*ago|posted\s+on\s+.*|\d+\s+(day|week|month)s?\s+ago)/i);
                        if (dateMatch && dateMatch[0] && text.length < 40) {
                            date_posted = dateMatch[0];
                            return false;
                        }
                    });
                }
            }

            // FIXED: Description extraction with guaranteed fallbacks
            let description_html = '';
            let description_text = '';

            // Try to find the best container
            const containerResult = findBestDescriptionContainer($);
            
            if (containerResult && containerResult.selector) {
                const container = containerResult.$original(containerResult.selector).first();
                
                if (container && container.length) {
                    // Generate HTML
                    description_html = sanitizeDescription($, container, request.url);
                    
                    // Generate text from HTML if available
                    if (description_html && description_html.length > 50) {
                        try {
                            description_text = cheerioLoad(description_html).text().replace(/\s+/g, ' ').trim();
                        } catch (e) {
                            crawlerLog.warn(`Error converting HTML to text: ${e.message}`);
                        }
                    }
                    
                    // Fallback: If HTML->text conversion failed, get text directly
                    if (!description_text || description_text.length < 50) {
                        description_text = cleanTextFromEl(container);
                    }
                    
                    // Final fallback: If HTML is missing but we have text, keep it
                    // If text is missing but we have HTML, extract text again
                    if (!description_html && description_text && description_text.length > 50) {
                        crawlerLog.warn('HTML extraction failed but text available - keeping text only');
                    } else if (description_html && (!description_text || description_text.length < 50)) {
                        crawlerLog.warn('Text extraction weak - re-extracting from HTML');
                        try {
                            description_text = cheerioLoad(description_html).text().replace(/\s+/g, ' ').trim();
                        } catch (e) {
                            crawlerLog.error(`Failed to extract text from HTML: ${e.message}`);
                        }
                    }
                }
            }
            
            // Ultimate fallback: Extract from main/body if both are still empty
            if ((!description_html || description_html.length < 50) && (!description_text || description_text.length < 50)) {
                crawlerLog.warn(`Primary extraction failed for ${request.url}, using ultimate fallback`);
                
                const fallbackContainer = $('main').first().length ? $('main').first() : $('body').first();
                
                if (fallbackContainer && fallbackContainer.length) {
                    // Try HTML first
                    description_html = sanitizeDescription($, fallbackContainer, request.url);
                    
                    // Get text
                    if (description_html && description_html.length > 50) {
                        try {
                            description_text = cheerioLoad(description_html).text().replace(/\s+/g, ' ').trim();
                        } catch (e) {
                            description_text = cleanTextFromEl(fallbackContainer);
                        }
                    } else {
                        description_text = cleanTextFromEl(fallbackContainer);
                    }
                }
            }
            
            // Log extraction results
            crawlerLog.info(`Extracted from ${request.url}:`);
            crawlerLog.info(`  Title: ${title || 'MISSING'}`);
            crawlerLog.info(`  Company: ${company || 'MISSING'}`);
            crawlerLog.info(`  Location: ${location || 'MISSING'}`);
            crawlerLog.info(`  Date: ${date_posted || 'MISSING'}`);
            crawlerLog.info(`  Description HTML length: ${description_html ? description_html.length : 0} chars`);
            crawlerLog.info(`  Description text length: ${description_text ? description_text.length : 0} chars`);
            
            if (description_text && description_text.length > 0) {
                crawlerLog.debug(`  Text preview: ${description_text.substring(0, 200)}...`);
            }
            
            // Validation: Warn if either description is missing
            if (!description_html || description_html.length < 50) {
                crawlerLog.warn(`⚠️  Missing or short HTML description for ${request.url}`);
            }
            if (!description_text || description_text.length < 50) {
                crawlerLog.warn(`⚠️  Missing or short text description for ${request.url}`);
            }

            const item = {
                url: request.url,
                title: title && title.length ? title : null,
                company: company && company.length ? company : null,
                location: location && location.length ? location : null,
                date_posted: date_posted && date_posted.length ? date_posted : null,
                description_html: description_html && description_html.length > 50 ? description_html : null,
                description_text: description_text && description_text.length > 50 ? description_text : null,
                _source: 'workopolis.com',
                _fetchedAt: new Date().toISOString(),
                _from: 'detail',
            };
            
            // Log missing key fields for diagnostics
            if (!title) crawlerLog.warn(`Detail page missing title: ${request.url}`);
            if (!company) crawlerLog.debug(`Company not found for ${request.url}`);
            if (!item.description_html && !item.description_text) {
                crawlerLog.error(`❌ Both descriptions missing for ${request.url}`);
            } else if (!item.description_html || !item.description_text) {
                crawlerLog.warn(`⚠️  Only one description type available for ${request.url}`);
            }

            await Dataset.pushData(item);
            jobsScraped++;
            crawlerLog.info(`✓ Job ${jobsScraped}/${RESULTS_WANTED} saved: ${title || 'Untitled'}`);
        }
    },
    
    failedRequestHandler: async ({ request }, error) => {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run(initialUrls.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
log.info(`✓ Scraping completed. Total jobs scraped: ${jobsScraped}/${RESULTS_WANTED} | Jobs enqueued: ${jobsEnqueued}`);

await Actor.exit();