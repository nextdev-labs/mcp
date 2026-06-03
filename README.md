# Nextdev MCP

The open-source MCP server that powers the [Nextdev Agent Commerce Index](https://www.joinnextdev.com/labs).

When an AI agent needs to choose an API and ground its integration code, it calls Nextdev. We return ranked recommendations scored on **agent-readiness** plus the structured API surface to build with.

This repo is the exact code that runs at [`https://www.joinnextdev.com/api/mcp`](https://www.joinnextdev.com/api/mcp). Audit it before you trust it.

## Why this exists

Every AI coding agent in 2026 makes two decisions per integration: **which API to use**, and **how to use it**. Both decisions are made on training data that's 12-18 months stale. Nextdev sits in between — we maintain a live, structured index of API vendors plus their actual endpoints, sample code, and blog content. The agent calls us, we return decisions grounded in real surfaces.

## Quick install (use the hosted endpoint)

Add this to your MCP client config:

**Claude Code** (`~/.config/claude-code/mcp.json` or `.mcp.json` in your repo):

```json
{
  "mcpServers": {
    "nextdev": {
      "type": "http",
      "url": "https://www.joinnextdev.com/api/mcp"
    }
  }
}
```

**Cursor** (Settings → MCP):
- Name: `nextdev`
- URL: `https://www.joinnextdev.com/api/mcp`
- Transport: HTTP

**Windsurf / Cline / Continue / any MCP-compliant client**: same URL, HTTP transport.

No API key. No login. Restart your IDE and the tools appear.

## Tools

| Tool | What it does |
| --- | --- |
| `list_orgs` | List every API vendor in the Nextdev index — slug, name, blog URL, llms.txt URL. Call this first to discover what you can query. |
| `get_api_surface` | Return the structured surface for one vendor — every endpoint (method + path + summary + params + returns), every SDK method, the auth scheme. Use this to ground integration code in real symbols. |
| `query_blog` | Search a vendor's developer blog for production patterns. Token-overlap ranking, filterable by category. |
| `search_docs` | Hybrid BM25 + embedding semantic search across the vendor's real docs site. Returns top-K reference pages. Requires `OPENAI_API_KEY` for embeddings; falls back to BM25-only without it. |
| `recommend_api` | **The recommendation engine.** Given a `use_case`, returns ranked vendors with combined score (60% agent-readiness + 40% use-case keyword overlap), rationale, and a `nextStep` pointer. |
| `compare_apis` | **The comparison engine.** Side-by-side on agent-readiness, endpoint count, SDK depth, auth, and use-case-matching endpoints. Returns a tally and "choose X when…" rationale per side. |

## Methodology

Agent-readiness scores are curated by the Nextdev team and calibrated against the public leaderboard at [/labs](https://www.joinnextdev.com/labs). The scoring axis rewards:

- A published, parseable `llms.txt`
- Structured `apiSurface` (OpenAPI, typed SDKs, machine-readable auth)
- Code-block stability across pages
- Webhook + event coverage
- Existence of an MCP server (or how easy it is to build one)

Combined score in `recommend_api`:
```
score = 0.6 * agent_readiness + 0.4 * use_case_keyword_overlap
```

We default to weighting agent-readiness higher than keyword fit because the vendor with cleaner docs almost always produces a better integration, even if it's a slightly looser semantic match.

## Run it yourself (advanced)

Most users should just use the hosted endpoint. If you want to fork and run a local copy against your own data:

```bash
git clone git@github.com:nextdev-labs/mcp.git
cd mcp
npm install
```

You'll need a Firestore project populated with the same schema we use:

- `organizations/{id}` — `{ subdomainSlug, companyName, productType: "agent-tool", description, industry, companyWebsite }`
- `apiSurface/{orgId}` — `{ docsRoot, endpoints[], sdkMethods[], realCodeSamples[], authSchemes[], detectedLanguages[] }`
- `blogPosts/{id}` — `{ organizationId, slug, title, excerpt, category, status, publishedAt, searchableText, keywords[] }`
- `toolDocs/{slug}/entries/{hash}` — `{ url, title, description, embedding[] }`

Set the env vars (`.env` — not checked in):
```
FIREBASE_PROJECT_ID=your-project
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# Optional — enables embedding-based ranking for search_docs.
# Without it, search_docs falls back to BM25-only (still useful, just less semantic).
OPENAI_API_KEY=sk-...
```

Then:
```bash
npm run dev      # http server on :3000
# or
npm run build && npm start
```

## How to contribute

This project is open to contributors. The most useful contributions today:

1. **More transports.** Currently HTTP only. A `stdio` variant would let users run it locally without the network roundtrip.
2. **Better scoring.** The recommendation engine combines agent-readiness + keyword overlap. Smarter ranking that doesn't require an LLM round-trip per request is welcome.
3. **New tools.** Suggested next ones: `get_best_for(category, axis)`, `get_changelog(orgSlug)`, `compare_vs_self_over_time(orgSlug)`.
4. **Rate limiting.** The hosted endpoint will need this before adoption scales.

Open an issue or a PR. We respond.

## License

[MIT](./LICENSE) — use it, fork it, build on it. We just ask that you don't pretend you wrote it.

## Links

- Hosted endpoint: https://www.joinnextdev.com/api/mcp
- Leaderboard: https://www.joinnextdev.com/labs
- Methodology: https://www.joinnextdev.com/labs/methodology
- Twitter: [@joinnextdev](https://x.com/joinnextdev)
