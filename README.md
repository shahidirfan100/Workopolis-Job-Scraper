## What does Workopolis Jobs Scraper do?

Workopolis Jobs Scraper extracts job listings from Workopolis.com, one of Canada's largest job search platforms. Enter a keyword and optional location to collect job titles, company names, locations, salary data, employment types, work arrangements, and full job descriptions. The Actor returns structured data ready for market research, recruitment intelligence, and talent analytics.

## Why use Workopolis Jobs Scraper?

- **Nationwide Canadian coverage** - Search all of Canada or target specific cities like Toronto, Vancouver, Calgary, or Montreal.
- **Rich job-level detail** - Collect salary ranges, employment types, remote/hybrid settings, benefits, requirements, and full descriptions in both HTML and plain text.
- **Scalable collection** - Set your desired result count with no hard upper limit. The Actor paginates automatically through results.
- **Automation-ready output** - Export datasets to JSON, CSV, Excel, or connect via API, webhooks, and no-code tools.
- **Incremental data saving** - Results are saved page by page as they are collected. If a run is interrupted, all data up to that point is preserved.

## What data can you extract from Workopolis?

| Field | Description |
|-------|-------------|
| `title` | Job title |
| `company` | Employer name |
| `location` | Job location with city and province |
| `salary` | Salary or compensation range when available |
| `employmentType` | Employment type such as full-time, contract, or part-time |
| `workSettings` | Work arrangement such as remote, hybrid, or on-site |
| `datePosted` | Posted or published date |
| `benefits` | Benefits summary when listed |
| `requirements` | Required skills or qualifications |
| `description_html` | Full job description in sanitized HTML |
| `description_text` | Full job description as plain text |
| `url` | Direct Workopolis job page URL |
| `jobKey` | Unique job identifier |

## How to use Workopolis Jobs Scraper

1. Open the Actor on Apify Store.
2. Enter a job keyword such as `software engineer` or `data analyst`.
3. Optionally enter a location such as `Toronto` or leave it blank to search all of Canada.
4. Set the maximum number of jobs to collect and optional recency filter.
5. Run the Actor and download the dataset when complete.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keyword` | String | No | `software engineer` | Job search keyword, title, or skill phrase |
| `location` | String | No | - | Location to search. Leave empty for nationwide |
| `posted_date` | String | No | `anytime` | Recency filter: `anytime`, `24h`, `7d`, or `30d` |
| `startUrls` | Array | No | `[]` | Custom Workopolis search URLs to use instead of keyword and location |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect |
| `max_pages` | Integer | No | `10` | Safety limit for pagination depth |
| `proxyConfiguration` | Object | No | Apify Proxy | Proxy settings for stable collection |

## Output Data

| Field | Type | Description |
|-------|------|-------------|
| `url` | String | Direct Workopolis job page URL |
| `jobKey` | String | Unique job identifier |
| `title` | String | Job title |
| `company` | String | Employer name |
| `location` | String | Job location |
| `salary` | String or Null | Salary or compensation range |
| `employmentType` | String or Null | Employment type such as Full-time, Contract |
| `workSettings` | String or Null | Work arrangement such as Remote, Hybrid |
| `datePosted` | String or Null | Posted date |
| `benefits` | String or Null | Benefits summary when available |
| `snippet` | String or Null | Listing preview text |
| `requirements` | String or Null | Required skills or qualifications |
| `description_html` | String or Null | Full job description in sanitized HTML |
| `description_text` | String or Null | Full job description as plain text |
| `_source` | String | Source hostname |
| `_fetchedAt` | String | ISO timestamp of extraction |

## Usage Examples

### Nationwide Search

Search all of Canada with no location filter:

```json
{
  "keyword": "software engineer",
  "results_wanted": 50
}
```

### Location-Specific Search with Recency Filter

Collect recent jobs in a specific city with a 7-day recency filter:

```json
{
  "keyword": "data analyst",
  "location": "Vancouver",
  "posted_date": "7d",
  "results_wanted": 100
}
```

### URL-Driven Search

Use one or more custom Workopolis search URLs directly:

```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=full+stack+developer&l=Calgary" }
  ],
  "results_wanted": 50
}
```

### Large Collection Run

Collect a large dataset for analysis or monitoring:

```json
{
  "keyword": "nurse",
  "location": "Toronto",
  "results_wanted": 1000,
  "max_pages": 50
}
```

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
  "datePosted": "2026-07-15",
  "benefits": "Health insurance, Paid time off",
  "snippet": "Build and maintain scalable backend services...",
  "requirements": "Node.js, TypeScript, APIs",
  "description_html": "<p>Full role description...</p>",
  "description_text": "Full role description...",
  "_source": "workopolis.com",
  "_fetchedAt": "2026-07-28T10:30:00.000Z"
}
```

## Tips for Best Results

- Use specific job titles and Canadian cities for more relevant results.
- Start with `results_wanted: 20` for quick testing before scaling up.
- Leave `location` empty to search across all of Canada for broader discovery.
- Use the `posted_date` filter to focus on the most recent listings.
- Enable Apify Proxy with residential groups for stable long-running collections.
- Some fields such as salary or benefits appear as null when the listing does not include that information.
- If a run is interrupted, all data collected up to that point remains in the dataset.

## Integrations

- **Google Sheets** - Send job data to spreadsheets for team collaboration.
- **Airtable** - Build searchable hiring intelligence bases.
- **Make** - Automate recurring extraction and downstream notifications.
- **Zapier** - Trigger workflows from fresh job data.
- **Webhooks** - Send output directly to your own systems.
- **API** - Access datasets programmatically from your applications.

### Export Formats

Apify datasets can be downloaded in JSON, CSV, Excel, XML, and other supported formats.

## Frequently Asked Questions

### How many jobs can I collect?

There is no hard limit. Set `results_wanted` and `max_pages` to whatever your project requires. The Actor stops when either limit is reached.

### Can I search nationwide without a location?

Yes. Leave the `location` field empty and the Actor searches all of Canada.

### Are full job descriptions included?

Yes. The Actor automatically enriches listings with both HTML and plain text descriptions when the initial payload does not include them.

### Can I use custom search URLs?

Yes. Provide one or more Workopolis search URLs in the `startUrls` field. These are used instead of the keyword and location inputs.

### Why do some fields appear empty?

Some job listings do not include every field such as salary, benefits, or requirements. Missing source data is returned as null.

### What happens if a run is interrupted?

Data is saved page by page as it is collected. If a run stops early, all results up to that point remain in the dataset.

### Can I run this Actor on a schedule?

Yes. Apify Console supports scheduling runs hourly, daily, weekly, or at custom intervals.

### Is this Actor suitable for non-technical users?

Yes. The Actor can be run from Apify Console with form-based inputs, and the dataset can be downloaded without writing code.

## Related Actors

- [Foundit Jobs Scraper](https://apify.com/shahidirfan/foundit-jobs-scraper) - Extract job listings from Foundit (formerly Monster)
- [USA Jobs Scraper](https://apify.com/shahidirfan/usa-jobs-scraper) - Collect job listings from major US job boards
- [Bayt Jobs Scraper](https://apify.com/shahidirfan/Bayt-Jobs-Scraper) - Scrape job postings from Bayt.com
- [APEC Jobs Scraper](https://apify.com/shahidirfan/apec-jobs-scraper) - Extract executive and professional jobs from APEC.fr

## Support

For issues, feature requests, or custom Actor development, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate data collection from publicly available Workopolis listings. Users are responsible for complying with Workopolis terms of service and all applicable laws in their jurisdiction.
