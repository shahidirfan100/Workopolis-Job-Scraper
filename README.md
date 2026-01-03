# Workopolis Jobs Scraper

Scrape job listings from Workopolis.com - Canada's leading job board. Extract thousands of job postings with complete details including job title, company name, location, salary, employment type, and full job descriptions.

## What is Workopolis?

Workopolis is one of Canada's largest and most trusted job search platforms, connecting millions of job seekers with employers across all industries. This scraper allows you to automatically collect job postings from Workopolis for market research, recruitment analytics, salary benchmarking, and job market analysis.

## What data can you extract from Workopolis?

This scraper extracts comprehensive job listing data:

- **Job Title** - Full position title as listed
- **Company Name** - Hiring organization
- **Location** - City, province, or remote status
- **Salary Information** - Pay range when available
- **Employment Type** - Full-time, part-time, contract, etc.
- **Date Posted** - When the job was published
- **Job Description** - Complete job details and requirements
- **Direct URL** - Link to the original job posting

## Why scrape Workopolis jobs?

### Market Research
Analyze hiring trends across Canadian industries. Understand which skills are in demand and how job markets evolve over time.

### Salary Benchmarking
Collect salary data to benchmark compensation packages. Compare pay rates across different roles, locations, and experience levels.

### Recruitment Analytics
Monitor competitor hiring activity. Track which companies are expanding and what roles they're filling.

### Job Aggregation
Build comprehensive job boards by combining listings from multiple sources including Workopolis.

### Academic Research
Study employment patterns, labor market dynamics, and workforce trends in Canada.

## How to use Workopolis Jobs Scraper

### Input Configuration

The scraper offers flexible search options:

| Parameter | Description | Example |
|-----------|-------------|---------|
| Keyword | Job title or skills to search | `software engineer`, `data analyst`, `nurse` |
| Location | City or province | `Toronto`, `Vancouver`, `Alberta` |
| Posted Date | Filter by recency | `anytime`, `24h`, `7d`, `30d` |
| Maximum Jobs | Number of jobs to collect | `50`, `100`, `500` |
| Collect Details | Fetch full job descriptions | `true` or `false` |

### Example: Search for Software Jobs in Toronto

```json
{
  "keyword": "software developer",
  "location": "Toronto",
  "posted_date": "7d",
  "results_wanted": 100,
  "collectDetails": true
}
```

### Example: Quick Search Without Descriptions

```json
{
  "keyword": "marketing manager",
  "location": "Vancouver",
  "results_wanted": 200,
  "collectDetails": false
}
```

### Example: Using a Direct URL

```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=accountant&l=Calgary" }
  ],
  "results_wanted": 50
}
```

## Output Format

Each job listing is returned as a structured JSON object:

```json
{
  "url": "https://www.workopolis.com/jobsearch/viewjob/abc123",
  "title": "Senior Software Engineer",
  "company": "Tech Solutions Inc.",
  "location": "Toronto, ON",
  "salary": "$90,000 - $120,000/year",
  "employmentType": "Full-time",
  "datePosted": "2025-01-02",
  "description_text": "We are looking for an experienced software engineer...",
  "description_html": "<div>We are looking for an experienced software engineer...</div>"
}
```

### Output Fields

| Field | Type | Description |
|-------|------|-------------|
| url | String | Direct link to the job posting |
| title | String | Job position title |
| company | String | Name of the hiring company |
| location | String | Job location (city, province) |
| salary | String | Salary range if available |
| employmentType | String | Type of employment |
| datePosted | String | Publication date |
| description_text | String | Plain text job description |
| description_html | String | HTML formatted description |

## How many jobs can you scrape?

The scraper can collect thousands of job listings per run. Adjust the `results_wanted` parameter based on your needs:

- **Quick sample**: 25-50 jobs
- **Standard analysis**: 100-500 jobs
- **Comprehensive research**: 1000+ jobs

## Integrations and Data Export

Export your scraped data in multiple formats:

- **JSON** - Structured data for applications
- **CSV** - Spreadsheet compatible
- **Excel** - Direct Excel file export
- **API** - Access via Apify API

Integrate with your workflow using:
- Webhooks for automated notifications
- Apify integrations with Zapier, Make, and Google Sheets
- Direct API access for custom applications

## Tips for Best Results

1. **Be Specific** - Use precise keywords for more relevant results
2. **Filter by Date** - Use `posted_date` to focus on recent listings
3. **Adjust Limits** - Set appropriate `results_wanted` for your use case
4. **Enable Proxies** - Use residential proxies for reliable scraping
5. **Check Output** - Review initial results before large-scale runs

## Frequently Asked Questions

### How often is Workopolis data updated?
Workopolis updates job listings continuously. Run the scraper daily or weekly to capture new postings.

### Can I scrape jobs from specific industries?
Yes, use industry-specific keywords like "healthcare", "finance", or "technology" to filter results.

### Is the salary information always available?
Salary data is extracted when employers include it in their listings. Not all jobs display salary information.

### How do I handle pagination?
The scraper automatically handles pagination. Simply set your desired `results_wanted` count.

### Can I use custom search URLs?
Yes, use the `startUrls` parameter with any valid Workopolis search URL.

## Pricing and Costs

This scraper is optimized for efficiency:

- **Low compute usage** - Minimal processing overhead
- **Fast execution** - Collects jobs quickly
- **Cost effective** - Designed to minimize platform costs

Estimated cost: Approximately $1-5 per 1000 jobs depending on settings.

## Legal and Compliance

This scraper is intended for legitimate business purposes including market research, analytics, and data aggregation. Users are responsible for ensuring their use complies with Workopolis terms of service and applicable laws.

## Support and Feedback

If you encounter issues or have suggestions:

1. Check the run log for error messages
2. Verify your input configuration
3. Contact support through Apify platform

We welcome feedback to improve this scraper.

## Related Scrapers

Looking for more job data? Check out scrapers for:
- Indeed Jobs
- LinkedIn Jobs
- Glassdoor Jobs
- Monster Jobs
- ZipRecruiter Jobs

## Changelog

### Version 2.0.0
- Improved reliability and speed
- Enhanced data extraction
- Better error handling
- Optimized for cost efficiency