# Workopolis Jobs Scraper

Extract Workopolis job listings at scale with rich, structured output for analytics, lead generation, and recruitment intelligence. Collect job titles, companies, locations, compensation details, and full descriptions in a dataset-ready format. Built for fast, reliable collection and consistent downstream use.

## Features

- **High-volume job collection** — Gather large job datasets across keywords and locations.
- **Full job content capture** — Collect both `description_html` and `description_text` for each job.
- **Detailed field coverage** — Get company, salary, job type, benefits, date posted, and requirements.
- **Automatic pagination** — Continue through result pages until your target count is reached.
- **Flexible search input** — Use either `keyword` + `location` or direct `startUrls`.
- **Production-friendly output** — Export clean data for BI tools, sheets, and pipelines.

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
| `location` | String | No | `Toronto` | Search location (city, region, or province). |
| `posted_date` | String | No | `anytime` | Recency filter: `anytime`, `24h`, `7d`, `30d`. |
| `collectDetails` | Boolean | No | `true` | When enabled, enriches jobs with full descriptions and additional details. |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect. |
| `max_pages` | Integer | No | `10` | Safety limit for result pages. |
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
| `description_html` | String \| Null | Full job description in sanitized HTML format. |
| `description_text` | String \| Null | Plain text description for analysis/search. |
| `_source` | String | Source hostname. |
| `_fetchedAt` | String | ISO timestamp of extraction. |

---

## Usage Examples

### Basic Run

```json
{
  "keyword": "software engineer",
  "location": "Toronto",
  "results_wanted": 20,
  "collectDetails": true
}
```

### Recent Jobs Only

```json
{
  "keyword": "data analyst",
  "location": "Vancouver",
  "posted_date": "7d",
  "results_wanted": 100,
  "collectDetails": true
}
```

### URL-Driven Search

```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=full+stack+developer&l=Calgary" }
  ],
  "results_wanted": 50,
  "collectDetails": true
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
- Run broader queries only when you need larger discovery datasets.

### Keep `collectDetails` Enabled
- Leave `collectDetails` as `true` when you need full job descriptions.
- Disable it only for very fast headline-level scans.

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
You can collect up to your configured limits. Set `results_wanted` and `max_pages` based on your target volume.

### Can I search by city and keyword together?
Yes. Use `keyword` and `location` together for focused results.

### Are full descriptions included?
Yes. With `collectDetails: true`, the actor enriches jobs with both HTML and plain text descriptions.

### Can I run from a custom search URL?
Yes. Provide one or more URLs in `startUrls`.

### Why do some fields appear empty?
Some job listings do not provide every field (for example salary or benefits). Missing source data is returned as `null`.

### Is pagination automatic?
Yes. The actor handles pagination until limits are reached.

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