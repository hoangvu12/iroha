### Late non-stream answers

A non-stream Request (no `"stream": true`) answers or fails within Cloudflare's 100 s too. Waiting for an upstream answer to begin is bounded by the first-byte budget (at most 95 s; failures keep their HTTP status). Some Providers send their headers at once and then take minutes to write the body; for those:

- When an upstream answer has begun but its body is still arriving 10 s after the Request (and 5 s after the upstream's headers; at the latest 95 s after the Request), Iroha commits the response: `200` and `Content-Type: application/json`, no body yet.
- Then a newline goes out whenever the response is silent for 15 s. Whitespace before a JSON value is valid JSON, so every client and SDK parses the answer, which follows unchanged. Iroha keeps trying keys within the budget meanwhile, as before.
- A failure after the commit is the error envelope of your Shape as the body, with the same `code`, `hint`, `request_id` and `details`, under the `200` already sent. The Request records `status` 200 with `error.code` saying why it failed. Check for a top-level `error` (Anthropic: `"type": "error"`) when a non-stream answer took longer than 10 s.

An answer complete within 10 s of the Request, or within 5 s of the upstream's headers (before the 95 s mark), is never committed early and keeps the Provider's status line and bytes.
