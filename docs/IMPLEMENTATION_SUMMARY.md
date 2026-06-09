# Implementation Summary: stdio transport, payload limit, and rate limiter

## Summary
This change adds a `stdio` transport and improves HTTP reliability by enforcing a request payload size limit and adding a simple in-memory IP-based rate limiter.

## Files changed
- `src/stdio.ts` — new: line-delimited JSON-RPC over stdin/stdout transport.
- `src/http.ts` — modified: added payload size limit (default 5MB) and in-memory per-IP rate limiting (50 requests/minute).
- `package.json` — modified: added `start:stdio` and `dev:stdio` scripts.
- `README.md` — modified: documented `stdio` usage.
- `tests/http_tests.js` — new: test script for oversized payload and rate-limiter flood test.

## Behavior
- `stdio` transport: reads one JSON message (object or array) per line from `stdin`, routes via `dispatch()` and writes JSON-RPC responses to `stdout` (one JSON object/array per line).
- Payload limit: `readBody(req, maxBytes)` will reject and destroy the connection if the body exceeds 5MB (configurable via the helper call).
- Rate limiter: in-memory map keyed by IP (`x-forwarded-for` or `socket.remoteAddress`) enforcing `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` window. Exceeding clients receive HTTP `429 Too Many Requests`.

## How to run locally
1. Typecheck and build:

```bash
npm run typecheck
npm run build
```

2. Run HTTP server (default port 3000):

```bash
npm start
# or (dev)
npm run dev
```

3. Run stdio transport (dev):

```bash
npm run dev:stdio
# or (built)
npm run start:stdio
```

4. Run test script (server must be running):

```bash
node tests/http_tests.js
```

## Verification results (local)
- `tsc` typecheck: passed
- `npm run build`: passed
- `stdio` smoke test: returned `tools/list` response
- Oversized payload (>5MB): connection reset / request rejected (expected)
- Rate limiter flood (60 concurrent posts): a subset of requests returned `429` while others returned `200` — limiter working as intended