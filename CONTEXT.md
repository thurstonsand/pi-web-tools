# Context

- **Web tools**: The two tools this package registers with pi: `web_fetch` and `web_search`.
- **Fetcher**: A fetch backend for one source (`github`, `parallel`, `local`).
- **Document**: The result of resolving one URL: digest fields plus one or more bodies on disk.
- **Digest**: The description of a document in the tool result — title, facts, link, body files with sizes, capped excerpt.
- **Excerpt**: A provider-authored preview of a document.
- **Highlights**: Objective-steered answers to a question the agent posed when requesting the document.
- **Fetch worker**: The singleton standalone process that owns `playwright-core` and the browser; the only process that ever touches a browser driver.
- **Extractor**: The HTML→markdown seam inside the local fetcher.
