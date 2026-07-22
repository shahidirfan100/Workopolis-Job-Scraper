# Workopolis Jobs Scraper

Extract Workopolis job listings at scale with rich, structured output for analytics, lead generation, and recruitment intelligence. Collect job titles, companies, locations, salary data, and full descriptions in a dataset-ready format. Data saves incrementally page by page so partial results are never lost.

## Features

- **High-volume job collection** — Gather large job datasets across Canada with no hard limits on results or pages.
- **Full job content capture** — Collect both `description_html` and `description_text` for every job.
- **Detailed field coverage** — Get company, salary, job type, benefits, date posted, and requirements.
- **Automatic pagination** — Continue through result pages until your target count is reached.
- **Nationwide search** — Leave location empty to search all of Canada.
- **Incremental saving** — Each page's results are saved as you go, not batched at the end.
- **Clean output records** — Duplicate items and incomplete rows are filtered before saving.
- **Flexible search input** — Use `keyword` alone, `keyword` + `location`, or direct `startUrls`.

## Use Cases

### Talent Market Research
Track hiring volume and role trends by city, title, and recency. Build recurring reports for workforce and labor-market insights.

### Recruitment Intelligence
Monitor who is hiring, where demand is increasing, and which roles are growing fastest. Compare companies and locations over time.

### Compensation Benchmarking
Capture available salary data to benchmark compensation by role and region. Support planning with real listing-level evidence.

### Job Board Aggregation
Feed structured Workopolis data into internal dashboards or multi-source job platforms. Maintain consistent schemas across sources.

### Academic and Economic Analysis
Use historical and recurring job listing data for research projects in labor economics, education, and regional development.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | No | — | Optional list of Workopolis search URLs to use directly. |
| `keyword` | String | No | `software engineer` | Search keyword, title, or skill phrase. |
| `location` | String | No | — | Search location. Leave empty to search nationwide. |
| `posted_date` | String | No | `anytime` | Recency filter: `anytime`, `24h`, `7d`, `30d`. |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect. No upper limit. |
| `max_pages` | Integer | No | `10` | Safety limit for result pages. No upper limit. |
| `proxyConfiguration` | Object | No | Apify Proxy Residential | Proxy setup for stability and reliability. |

---

## Output Data

Each dataset item includes:

| Field | Type | Description |
|-------|------|-------------|
| `url` | String | Direct Workopolis view-job URL. |
| `jobKey` | String | Unique job identifier. |
| `title` | String | Job title. |
| `company` | String | Employer name. |
| `location` | String | Job location. |
| `salary` | String \| Null | Salary or compensation text when available. |
| `employmentType` | String \| Null | Employment type (full-time, contract, etc.). |
| `workSettings` | String \| Null | Work arrangement details (for example, remote/hybrid). |
| `datePosted` | String \| Number \| Null | Posted/published date data from source. |
| `benefits` | String \| Null | Benefits summary when available. |
| `snippet` | String \| Null | Listing preview text. |
| `requirements` | String \| Null | Requirement highlights from listing data. |
| `description_html` | String \| Null | Full job description in sanitized HTML using semantic tags only such as `p`, `br`, `strong`, `li`, `ul`, and headings. |
| `description_text` | String \| Null | Plain text description for analysis/search. |
| `_source` | String | Source hostname. |
| `_fetchedAt` | String | ISO timestamp of extraction. |

---

## Usage Examples

### Nationwide Search

Search all of Canada with no location filter:

```json
{
  "keyword": "software engineer",
  "results_wanted": 50
}
```

### Location-Specific Search

```json
{
  "keyword": "data analyst",
  "location": "Vancouver",
  "posted_date": "7d",
  "results_wanted": 100
}
```

### URL-Driven Search

```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=full+stack+developer&l=Calgary" }
  ],
  "results_wanted": 50
}
```

### Large Collection Run

```json
{
  "keyword": "nurse",
  "location": "Toronto",
  "results_wanted": 1000,
  "max_pages": 50
}
```

---

## Sample Output

```json
{
  "url": "https://www.workopolis.com/jobsearch/viewjob/abc123",
  "jobKey": "abc123",
  "title": "Software Engineer",
  "company": "Example Corp",
  "location": "Toronto, ON",
  "salary": "$95,000 - $120,000/year",
  "employmentType": "Full-time",
  "workSettings": "Hybrid",
  "datePosted": 1770755092538,
  "benefits": "Health insurance, Paid time off",
  "snippet": "Build and maintain scalable backend services...",
  "requirements": "Node.js, TypeScript, APIs",
  "description_html": "<p>Full role description...</p>",
  "description_text": "Full role description...",
  "_source": "workopolis.com",
  "_fetchedAt": "2026-02-13T12:00:00.000Z"
}
```

---

## Tips for Best Results

### Start With Focused Queries
- Use specific role names and locations for higher relevance.
- Run broader queries (nationwide, no location) when you need large discovery datasets.

### Description Enrichment Is Automatic
- Full descriptions are fetched automatically when listing payloads do not include them.
- No extra input parameter is required for detail enrichment.

### Data Saves Incrementally
- Results are saved page by page as they are collected.
- If a run is interrupted, all data up to that point is preserved in the dataset.

### Output Is Cleaned Before Export
- Duplicate job keys are removed automatically.
- Empty values are omitted so downstream datasets stay cleaner.

### Use Practical Limits
- Use `results_wanted: 20` for quick checks.
- Increase to 100+ for reporting and trend analysis.

### Use Reliable Proxy Settings
- Keep Apify Proxy enabled for stable collection.
- Residential proxy groups are recommended for consistency.

---

## Integrations

- **Google Sheets** — Share job datasets with non-technical teams.
- **Airtable** — Build searchable hiring intelligence bases.
- **Make** — Automate recurring extraction and notifications.
- **Zapier** — Trigger workflows from fresh job data.
- **Webhooks** — Send output directly to your own endpoints.

### Export Formats

- **JSON** — Application and pipeline friendly.
- **CSV** — Spreadsheet analysis and BI imports.
- **Excel** — Business reporting workflows.
- **XML** — Legacy system integrations.

---

## Frequently Asked Questions

### How many jobs can I collect?
There is no hard limit. Set `results_wanted` and `max_pages` to whatever your project requires. The actor stops when either limit is reached.

### Can I search nationwide without a location?
Yes. Leave the `location` field empty and the actor searches all of Canada.

### Can I search by city and keyword together?
Yes. Use `keyword` and `location` together for focused results.

### Are full descriptions included?
Yes. The actor automatically enriches jobs with both HTML and plain text descriptions when needed.

### Can I run from a custom search URL?
Yes. Provide one or more URLs in `startUrls`.

### Why do some fields appear empty?
Some job listings do not provide every field (for example salary or benefits). Missing source data is returned as `null`.

### Is pagination automatic?
Yes. The actor handles pagination until your result or page limit is reached.

### What happens if a run is interrupted?
Data is saved page by page as it is collected. If a run stops early, all results up to that point remain in the dataset.

---

## Support

For issues or improvement requests, open a message through the Apify actor page.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Schedules](https://docs.apify.com/platform/schedules)

---

## Legal Notice

Use this actor only for legitimate data collection and analysis. You are responsible for compliance with Workopolis terms and all applicable laws in your jurisdiction.
