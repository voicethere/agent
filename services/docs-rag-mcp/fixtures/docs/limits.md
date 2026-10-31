# API rate limits

The public API allows 600 requests per minute per API token. A request over the limit gets HTTP status 429 and a `Retry-After` header that says how many seconds to wait.

## Pagination

List endpoints return at most 100 items per page. Pass the `cursor` value from the previous response to get the next page.
