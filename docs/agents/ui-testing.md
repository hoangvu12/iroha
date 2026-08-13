# UI testing

UI changes in this repository ship without browser or JS-DOM tests.
Happy-dom, @testing-library/react, jsdom, Playwright, and similar
harnesses are not in use. Tests against the HTTP API are.

## Why not

- **The harness tax is bigger than the assurance.** Wiring the React
  tree through the assembled Elysia application requires installing a
  fetch bridge, stashing the native `Request` / `Response` / `Headers`
  so happy-dom's stripping rules don't sign the test session out, and
  either per-test setup files or a preload that conflicts with the
  server-side test suite. The plumbing ends up longer than the
  component it covers.
- **The seam we actually care about is the HTTP one.** Every UI form
  posts JSON to `/api/v1/admin/...` and every render reads it back.
  Asserting those JSON contracts in `test/http/providers.test.ts`,
  `test/http/upstream-keys.test.ts`, etc. covers the same behaviour a
  browser test would, with a sharper failure message and no DOM tax.
- **UI changes land often.** The Owner-facing UI is iterated quickly;
  a slow or fragile test harness slows the iteration without catching
  regressions the HTTP suite wouldn't already catch.

## What this means for tickets

- UI tickets do not write browser tests.
- If a ticket's acceptance bullets include "browser tests pass", mark
  the bullet unchecked and record the deferral in a `## Comments`
  block on the ticket file. The HTTP-suite coverage stands in.
- A real-browser suite (Playwright, etc.) is a deferred follow-up
  should the UI work ever justify a heavier toolchain. Until then,
  the answer to "are there UI tests?" is "no".