# Workopolis Jobs Scraper

Extract job listings from [Workopolis.com](https://www.workopolis.com) - Canada's leading job search platform. This actor scrapes job postings with detailed information including title, company, location, description, and posting date.

## Features

- 🔍 **Flexible Search**: Search by keyword, location, or provide custom Workopolis search URLs
- 📄 **Detailed Extraction**: Optional full job detail scraping with complete descriptions
- 🔄 **Pagination Support**: Automatically handles multiple pages of search results
- 🛡️ **Proxy Support**: Built-in support for Apify Proxy to avoid blocking
- 💾 **Structured Output**: Clean, structured dataset with consistent fields
- ⚡ **Fast Performance**: Optimized scraping with concurrent requests

## Input Configuration

### Search Parameters

Configure your search using either **keyword/location** or **custom URLs**:

#### Option 1: Keyword & Location Search

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `keyword` | String | Job title or keywords to search for | `"software engineer"`, `"marketing manager"` |
| `location` | String | Geographic location to filter jobs | `"Toronto"`, `"Vancouver"` |
| `posted_date` | String | Filter by posting date: `anytime`, `24h`, `7d`, `30d` | `"7d"` |

#### Option 2: Custom URLs

| Field | Type | Description |
|-------|------|-------------|
| `startUrls` | Array | One or more Workopolis search URLs to scrape |

**Example:**
```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=software+engineer&l=Toronto" }
  ]
}
```

### Scraping Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `collectDetails` | Boolean | `true` | Visit each job's detail page for full description |
| `results_wanted` | Integer | `50` | Maximum number of jobs to collect |
| `max_pages` | Integer | `10` | Safety limit on search result pages |

### Advanced Options

| Field | Type | Description |
|-------|------|-------------|
| `proxyConfiguration` | Object | Proxy settings (Apify Proxy recommended) |
| `cookies` | String | Custom cookies as header string |
| `cookiesJson` | String | Custom cookies in JSON format |

## Output

The actor outputs a dataset with the following fields for each job:

```json
{
  "url": "https://www.workopolis.com/job/...",
  "title": "Senior Software Engineer",
  "company": "Tech Company Inc.",
  "location": "Toronto, ON",
  "date_posted": "2 days ago",
  "description_html": "<div>Job description in HTML...</div>",
  "description_text": "Job description in plain text...",
  "_source": "workopolis.com",
  "_fetchedAt": "2025-10-22T10:30:00.000Z",
  "_from": "detail"
}
```

### Output Fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | String | Direct link to the job posting |
| `title` | String | Job title |
| `company` | String | Hiring company name |
| `location` | String | Job location |
| `date_posted` | String | When the job was posted |
| `description_html` | String | Full job description in HTML format |
| `description_text` | String | Full job description in plain text |
| `_source` | String | Source website (always "workopolis.com") |
| `_fetchedAt` | String | ISO timestamp of when data was scraped |
| `_from` | String | Whether scraped from "list" or "detail" page |

## Usage Examples

### Example 1: Search for Software Jobs in Toronto

```json
{
  "keyword": "software engineer",
  "location": "Toronto",
  "posted_date": "7d",
  "results_wanted": 100,
  "collectDetails": true
}
```

### Example 2: Scrape from Custom URL

```json
{
  "startUrls": [
    { "url": "https://www.workopolis.com/search?q=data+analyst&l=Vancouver" }
  ],
  "results_wanted": 50,
  "collectDetails": true
}
```

### Example 3: Quick List-Only Scrape

```json
{
  "keyword": "marketing",
  "location": "Montreal",
  "collectDetails": false,
  "results_wanted": 200,
  "max_pages": 5
}
```

## Performance & Cost

- **Speed**: ~50-100 jobs per minute with detail scraping enabled
- **Compute Units**: Approximately 0.01-0.02 CU per job with details
- **Memory**: 1-2 GB recommended
- **Proxy**: RESIDENTIAL proxy recommended for best reliability

## Tips & Best Practices

1. **Use Proxies**: Enable Apify Proxy (RESIDENTIAL) to avoid being blocked
2. **Limit Results**: Start with smaller `results_wanted` values for testing
3. **Posted Date Filter**: Use `posted_date` to focus on recent listings
4. **collectDetails**: Disable for faster scraping if descriptions aren't needed
5. **Monitor Runs**: Check logs for any warnings or errors during execution

## Common Issues

### No Results Found
- Verify your search terms are valid on Workopolis.com directly
- Try broader keywords or remove location filters
- Check if the website structure has changed

### Actor Timeout
- Reduce `results_wanted` or `max_pages`
- Disable `collectDetails` for faster execution
- Increase memory allocation in actor settings

### Blocked Requests
- Enable Apify Proxy with RESIDENTIAL group
- Add custom cookies if needed
- Reduce concurrency by limiting results

## Use Cases

- 📊 **Market Research**: Analyze job market trends in Canada
- 🔔 **Job Alerts**: Monitor new postings for specific roles
- 📈 **Salary Analysis**: Collect salary data for benchmarking
- 🎯 **Recruitment**: Source candidates from job posting data
- 📝 **Content Creation**: Generate insights for career-related content

## Support

If you encounter any issues or have questions:
- Check the [Apify documentation](https://docs.apify.com)
- Review the actor's run log for error messages
- Contact support through the Apify platform

## License

This actor is provided as-is for use on the Apify platform. Please respect Workopolis.com's terms of service and robots.txt when using this scraper.