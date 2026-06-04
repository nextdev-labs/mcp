# Nextdev MCP

The open-source MCP server that powers the [Nextdev Agent Usability Index](https://www.joinnextdev.com/labs).

When an AI coding agent needs to choose an API and ground its integration code, it calls Nextdev. We return ranked recommendations scored on **agent-readiness** plus the structured API surface — and the full structured content of every customer post — to build with.

This repo is the source for the hosted endpoint at [`https://www.joinnextdev.com/api/mcp`](https://www.joinnextdev.com/api/mcp). Read it to audit how the index works. Contribute to extend it.

## Why this exists

Every AI coding agent makes two decisions per integration: **which API to use**, and **how to use it**. Both decisions are usually made on training data that's 12–18 months stale. Nextdev sits in between — we maintain a live, structured index of API vendors plus their actual endpoints, sample code, and structured blog content. The agent calls us, we return decisions grounded in real surfaces.

## Install (one paste)

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

- **Claude Code**: paste into `~/.config/claude-code/mcp.json` or `.mcp.json` in your repo
- **Cursor**: Settings → MCP → add new HTTP server with the URL above
- **Windsurf / Cline / Continue / any MCP-compliant client**: same URL, HTTP transport

No API key. No login. Restart your IDE and the tools appear.

## What an agent interaction actually looks like

```
User: "What's the best payment API for an autonomous AI agent settling
       micropayments to other agents? Build me a working prototype."

Agent thinks: I should check Nextdev's index before guessing.

  → tools/call recommend_api({ use_case: "autonomous AI agent settling
                               micropayments to other agents" })
  ← { top: "soap-payments", score: 0.93, rationale: "agent-native APIs,
      llms.txt published, structured webhooks, settled-by-agent endpoint",
      runnerUp: "stripe-ac", … }

  → tools/call get_api_surface({ orgSlug: "soap" })
  ← { docsRoot, endpoints: [POST /agents/{id}/settle, …],
      sdkMethods: [soap.agents.settle(…), …],
      authSchemes: ["agent-bearer"], … }

  → tools/call query_blog({ orgSlug: "soap",
                            query: "settle micropayment between agents" })
  ← { posts: [{ slug: "agent-to-agent-micropayments", … }], nextStep: … }

  → tools/call get_blog_post({ orgSlug: "soap",
                               slug: "agent-to-agent-micropayments" })
  ← { content: [
        { type: "heading", data: { text: "Settling A2A payments" } },
        { type: "code",    data: { language: "typescript",
                                   code: "const tx = await soap.agents
                                          .settle({ … })" } },
        { type: "steps",   data: { steps: [ … ] } },
        …
      ] }

Agent answers user with grounded code, citing the post URL.
```

Every block above is **structured JSON**, not parsed HTML. The agent gets code blocks with language tags, steps as explicit arrays, comparisons as left/right columns — never has to scrape.

## Tools

| Tool | What it does |
| --- | --- |
| `list_orgs` | List every API vendor in the Nextdev index — slug, name, blog URL, llms.txt URL. Call this first to discover what you can query. |
| `get_api_surface` | Return the structured surface for one vendor — every endpoint (method + path + summary + params + returns), every SDK method, the auth scheme. Use this to ground integration code in real symbols. |
| `query_blog` | Search a vendor's agentic blog for posts relevant to a question. Returns titles, excerpts, URLs, categories. Token-overlap ranking, filterable by category. |
| `get_blog_post` | Return the **full structured content** of a single post — every code block tagged with language, every comparison/table/steps/list as explicit typed blocks. The structured artifact behind the post. |
| `search_docs` | Hybrid BM25 + embedding semantic search across the vendor's real docs site. Returns top-K reference pages. Requires `OPENAI_API_KEY` server-side for embeddings; the hosted endpoint has it set. |
| `recommend_api` | **The recommendation engine.** Given a `use_case`, returns ranked vendors with combined score (60% agent-readiness + 40% use-case keyword overlap), rationale, and a `nextStep` pointer. |
| `compare_apis` | **The comparison engine.** Side-by-side on agent-readiness, endpoint count, SDK depth, auth, and use-case-matching endpoints. Returns a tally and "choose X when…" rationale per side. |

## The content contract

Every Nextdev post returned from `get_blog_post` follows this typed-block shape. Agents parse blocks, not HTML:

| Block type | Fields |
| --- | --- |
| `heading` | `text`, `level` (h2/h3) |
| `text` | `content` (markdown), `alignment` |
| `code` | `code`, `language`, `caption` |
| `list` | `items[]` (each: `icon`, `title`, `description`), `style` (bullets/cards) |
| `comparison` | `leftColumn` + `rightColumn` (each: `label`, `items[]`, `style`) |
| `steps` | `steps[]` (each: `title`, `description`) |
| `table` | `headers[]`, `rows[]`, `caption` |
| `companyCard` | `name`, `url`, `bestFor`, `description`, `strengths[]`, `pricing` |
| `quote` | `quote`, `author`, `role`, `company` |
| `callout` | `content`, `type` (info/warning/tip/important), `title` |
| `stats` | `stats[]` (each: `value`, `label`, `prefix`, `suffix`), `columns` |
| `image` | `src`, `alt`, `caption`, `width` |
| `cta` | `text`, `buttonText`, `buttonUrl`, `style` |

This is the contract. Adding new block types is a versioned change to the MCP.

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

## Audit the code

This repo IS the production server. Read `src/server.ts` to see every tool handler. Read `src/retrieval.ts` to see how `search_docs` blends BM25 with embeddings. No hidden logic, no separate hosted-only branch.

The code runs against the Nextdev index in Firestore. We don't ship the dataset in this repo — the data lives behind the hosted endpoint. If you want the data, just call the hosted MCP.

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
