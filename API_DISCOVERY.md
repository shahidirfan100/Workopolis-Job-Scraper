## Selected API

### Listing (primary)
- Endpoint: `https://www.workopolis.com/search`
- Method: `GET`
- Auth: None. Requests must present a browser-consistent TLS/header fingerprint, otherwise the edge may return an HTML challenge.
- Response: HTML containing a `script#__NEXT_DATA__` hydration payload. The job results live at `props.pageProps` and include `jobs`, `pageCursors`, `currentPageNumber`, and `resultCount`.
- Pagination: `cursor` query parameter. Read the next value from `pageProps.pageCursors[String(currentPageNumber + 1)]` and pass it as `?cursor=...` on the next request. When no `pageCursors` entry for the next page exists, the listing is exhausted.
- Search parameters: `q` (keyword), `l` (location), `t` (recency: `anytime`, `24h`, `7d`, `30d`), `cursor` (pagination).
- Page size: 25 listings per page.
- Fields available: `jobKey`, `snippet`, `title`, `jobCardTrackingKey`, `encodedUrl`, `requirements`, `jobTypes`, `benefits`, `remoteAttributes`, `uncategorized`, `botUrl`, `location`, `company`, `companyRating`, `salaryInfo`, `indeedApply`, `dateOnIndeed`, `sponsored`, `auction`, `camk`, `companyPageUrl`, `encodedJobClickPingUrl`.

### Listing (secondary, non-paginated)
- Endpoint: `https://www.workopolis.com/api/next/jobs`
- Method: `GET`
- Parameters: `q`, `l`, `locale` (required). Note: this endpoint ignores cursor/start/page parameters and always returns the first 20 results, so it is not used for pagination.

### Detail (enrichment)
- Endpoint: `https://www.workopolis.com/api/next/job`
- Method: `GET`
- Auth: None, same browser/session constraints as the listing endpoint.
- Purpose: enrich each listing with full description HTML, employer fallback data, work settings, benefits, qualifications, base salary, and date fields.
- Key parameters: `key` (jobKey), `locale`, `indeedApplyContinueUrl` (required), optional `jobCardTrackingKey`.
- Response fields: `jobTitle`, `jobKey`, `normalizedTitle`, `displayTitle`, `formattedLocation`, `city`, `state`, `jobTypes`, `workSettings`, `jobDescriptionHtml`, `employerName`, `compensation`, `dateOnIndeed`, `datePublished`, `benefits`, `qualifications`, `baseSalary`, `expired`, and more.

## Rejected Candidate
- Endpoint pattern: `https://www.workopolis.com/_next/data/{buildId}/search.json`
- Rejected because the `buildId` changes on every deployment and stale values cause request failures. The HTML hydration payload at `/search` exposes the same `pageProps` shape without depending on `buildId`, so the Actor reads results from there.

## Selection Notes
- The listing endpoint returns the same `pageProps` structure as the previously used `_next/data` route but is `buildId`-free, removing an entire class of intermittent bootstrap failures.
- Pagination is cursor-based through `pageCursors`; each page returns up to 25 listings.
- The detail endpoint is the only source of `jobDescriptionHtml` and structured salary/qualifications, since `pageProps.viewJobData` is empty on search result pages.
- `salaryInfo` on the listing is a formatted string (for example `$94,500–$118,000 a year`); the detail endpoint additionally returns a structured `baseSalary` with `minMinor`/`maxMinor` in minor currency units.
- Dates (`dateOnIndeed`, `datePublished`) are Unix epoch milliseconds.

## Request Pattern Notes
- Cloudflare edge behavior depends on the client TLS/header profile. Verified profiles that consistently return data with impit: `chrome124`, `chrome151`, `firefox`, `okhttp`. The bare `chrome` alias and `chrome131`/`chrome136`/`chrome142` are intermittently or consistently challenged, so the Actor rotates across the verified pool and switches away from a profile when it is blocked.
- The Actor fetches listing pages as the `__NEXT_DATA__` hydration payload and detail pages as JSON, and retries recoverable failures (edge challenge, `403`, `429`, `5xx`, network errors) with a bounded budget and profile rotation.
- `description_html` is restricted to semantic content tags only, with layout tags, scripts, styles, and attributes removed before output.
