# Changelog

## 1.0.0

First release.

- **convert** node: converts a Buffer, a file path or an https:// link to any of the target formats Converter Studio offers for it; target format and options from the node, the message, a context or an environment variable; waits for the result and sends the file as a Buffer (with `msg.filename` and `msg.contentType`), its download link or the conversion; max credits with "stop with an error" or "send the quote"; a callback URL when it doesn't wait; uploads in parts of 95 MB for large files; an Idempotency-Key on every conversion request.
- **conversion** node: gets a conversion by its ID, or confirms a quoted one, with waiting and download.
- **account** and **formats** nodes.
- **Converter Studio** config node: the API key as a Node-RED credential, and the base URL.
- Errors with Converter Studio's own message, for catch nodes, with `msg.error.code` and `msg.conversion`.
- Five example flows.
