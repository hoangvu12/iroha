# 03 — Client paste parser utility

**What to build:** Two pure parser functions in `ui/src/lib/parse-bulk-keys.ts`:

- `parseBulkKeyInput(text: string): ParseBulkResult` — parses a textarea paste. Auto-detects per-line: pipe-separated if the line contains `|`, otherwise CSV. Skips blank lines, skips `#` comments, and recognises an optional header row.
- `parseBulkKeyJson(text: string): ParseBulkResult` — parses a JSON array of `{upstreamKey, baseUrl?}` (no auto-detect; the caller picks the parser based on file extension).

Both functions return a discriminated `ParseBulkResult`:

```
type ParseBulkResult =
  | { ok: true; entries: { upstreamKey: string; baseUrl?: string }[]; skippedHeader: boolean; comments: number }
  | { ok: false; reason: 'malformed_json'; message: string }
```

No state, no DOM access, no React — purely string in, structured out.

**Blocked by:** None — can start immediately. Used by ticket 05.

**Status:** done

- [x] File `ui/src/lib/parse-bulk-keys.ts` exists with `parseBulkKeyInput` and `parseBulkKeyJson` exported.
- [x] `parseBulkKeyInput` per-line auto-detection rule: a line containing `|` is parsed as `upstreamKey|baseUrl` (split on the first `|` only; second-column content is preserved verbatim). A line not containing `|` is parsed as CSV: `upstreamKey,baseUrl` (split on the first `,` only).
- [x] Blank lines (whitespace-only) are silently skipped.
- [x] Lines whose first non-whitespace character is `#` are silently skipped.
- [x] Header detection: if the first non-blank, non-comment line is exactly `key,baseUrl` or `upstreamKey,baseUrl` (case-insensitive trim), it is treated as a header and skipped. The result reports `skippedHeader: true`.
- [x] Whitespace trimming: the upstream key and base URL are trimmed of leading/trailing whitespace. A blank upstream key after trim is reported as a per-line `problems` entry — except that the parser's `ok: true` result simply omits the entry (no entry with empty key is ever produced; the parser surfaces line-level problems separately if needed by extending the result type).
- [x] `baseUrl` is optional in both formats: `upstreamKey,` and `upstreamKey|` both mean "inherit Provider default" (the resulting entry omits `baseUrl`).
- [x] `parseBulkKeyJson` parses with `JSON.parse`, validates that the result is an array, and validates that each entry is an object with a string `upstreamKey` and an optional string `baseUrl`. Malformed JSON returns `{ ok: false, reason: 'malformed_json', message }`.
- [x] Both functions are exhaustively unit-tested in a new `ui/src/lib/parse-bulk-keys.test.ts` using `bun:test` (the project's existing test runner). Cases include: empty string, only blanks/comments, single key only, key+baseUrl pair, header row in both spellings, header row with extra whitespace, mixed CSV / pipe lines, comma inside a CSV base URL, `|` inside a CSV base URL, JSON array of `{upstreamKey, baseUrl?}`, malformed JSON, JSON array with non-object entries.
- [x] No dependency on React, no DOM access, no side effects. The parser is safe to call from any context.
