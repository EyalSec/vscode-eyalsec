# Changelog

## 0.1.0

First release.

- An **EyalSec** view in the activity bar lists your events per product, most severe first, with the API's paging followed for you and **Load more events** for the rest.
- Each event opens to its source, its sink, the value that reached the sink, the value when it came in, its impact, the command line that produced it, and the call path.
- Clicking the source, the sink or any frame of the call path opens that file at that line when it is in your workspace. Files are matched by the longest path ending that exists, or by your `eyalsec.pathMappings`.
- The API key is kept in VS Code's secret storage, per EyalSec address, and is sent only over HTTPS.
- Settings for sort order, severities, live or suppressed events, and batch size.
