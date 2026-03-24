## Selected API
- Endpoint: `https://www.workopolis.com/api/next/jobs`
- Method: GET
- Auth: None
- Pagination: `cursor` query parameter (plus `pageCursors` and `nextCursor` in payload)
- Fields available: `jobKey`, `title`, `company`/`companyName`, `location`/`formattedLocation`, `salaryInfo`, `salary`, `jobTypes`, `employmentType`, `dateOnIndeed`, `datePublished`, `snippet`, `benefits`, `requirements`, `remoteAttributes`, `jobCardTrackingKey`, `viewJobData`, `pageCursors`, `currentPageNumber`, `nextCursor`
- Fields currently missing in actor before API migration: full `description_html`, `description_text`, richer salary structure, work settings, benefits, requirements, pagination cursors, and stable unique identifiers from API payload
- Field count: 20+ (vs existing HTML parse baseline ~8-10)

## Secondary API
- Endpoint: `https://www.workopolis.com/api/next/job`
- Method: GET
- Auth: None
- Purpose: detail enrichment per `jobKey`
- Key params: `key`, `locale`, `indeedApplyContinueUrl`, optional `jobCardTrackingKey`
- Additional fields: `jobDescriptionHtml`, `description`, `employerName`, `formattedLocation`, `datePublished`, `dateOnIndeed`

## Optional Internal Next.js Endpoint
- Endpoint pattern: `https://www.workopolis.com/_next/data/{buildId}/search.json`
- Method: GET
- Auth: None
- Pagination: `cursor`
- Usage: bootstrap and fallback when build ID is available

## Selection Notes
- Primary listing endpoint selected because it is buildId-free, stable, and returns rich JSON with cursor pagination.
- Detail endpoint selected for full description enrichment and better company/date/location backfill.
- Combined API mode provides broader and cleaner output than HTML parsing while remaining fast and resilient.
