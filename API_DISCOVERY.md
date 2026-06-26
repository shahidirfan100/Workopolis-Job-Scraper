## Selected API
- Endpoint: `https://www.workopolis.com/api/next/jobs`
- Method: `GET`
- Auth: None, but direct non-browser HTTP can be challenged by Cloudflare
- Pagination: `cursor` query parameter, with `nextCursor` and `pageCursors` in payload
- Fields available: `jobKey`, `title`, `company`, `companyName`, `location`, `formattedLocation`, `salaryInfo`, `salary`, `jobTypes`, `employmentType`, `dateOnIndeed`, `datePublished`, `snippet`, `benefits`, `requirements`, `remoteAttributes`, `jobCardTrackingKey`, `viewJobData`, `currentPageNumber`, `nextCursor`
- Fields currently missing in the legacy HTML actor: stable `jobKey`, full description HTML/text, structured salary coverage, work setting data, benefits, requirements, and cleaner pagination metadata
- Field count: 20+ fields vs the legacy HTML parser's smaller field set

## Secondary API
- Endpoint: `https://www.workopolis.com/api/next/job`
- Method: `GET`
- Auth: None, but uses the same browser/session constraints as the listing endpoint
- Purpose: enrich each listing with description, employer fallback data, date, and location backfill
- Key parameters: `key`, `locale`, `indeedApplyContinueUrl`, optional `jobCardTrackingKey`

## Optional Candidate Rejected
- Endpoint pattern: `https://www.workopolis.com/_next/data/{buildId}/search.json`
- Rejected because the `buildId` changes often and the response path is less stable than `/api/next/jobs`
- It also failed the resiliency requirement because stale build IDs or Cloudflare HTML responses caused bootstrap failures

## Selection Notes
- `/api/next/jobs` is the best primary endpoint because it is buildId-free, supports cursor pagination, and returns the richest search payload
- `/api/next/job` is the best detail endpoint because it fills missing descriptions and backfills incomplete listing fields
- The final implementation is fully API-based and uses direct HTTP requests only
- `description_html` is restricted to semantic content tags only, with layout tags, scripts, styles, and attributes removed before output
