# Nextdev MCP — current developer-API docs for your coding agent

[![npm version](https://img.shields.io/npm/v/@nextdev-labs/mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@nextdev-labs/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![local-first](https://img.shields.io/badge/worklog-local--first-7DEFA1)](#also-query-your-own-work-history)

Your agent's training data on third‑party APIs is **months stale** — endpoint names change, params move, auth flows shift. This MCP is the fastest path to the **real, current docs**: name any tool, get its live‑indexed docs, semantically pinpoint the exact capability out of 100+ pages, and route to the literal source for ground truth.

**Also** — because your agent already writes a full transcript of every session to disk — it can query your own past work, locally. 100% local for the worklog, zero dependencies.

```bash
npx nextdev
```

One command registers the MCP and appends a short reflex block to your `AGENTS.md` / `CLAUDE.md` / `.cursorrules` so your agent uses it automatically. Restart your editor and ask: **“how do I do X with `<some API>`?”**

---

## The main event — developer‑API docs

| tool | what it does |
| --- | --- |
| `search_docs` | name any tool (`"Firecrawl"`, `"Stripe"`) + a plain‑English query → real, current docs, ranked, with canonical URLs. Resolves + **indexes unknown tools on the fly**. |
| `get_api_surface` | the structured **endpoint + parameter** catalog for a vendor — for *“which endpoint / which parameter does X”*, not just a doc page |
| `recommend_api` | ranked best‑API shortlist for a use case, with citations + agent‑readiness scores |
| `leave_review` | rate a vendor you actually integrated (verified, gold‑badge) |

**The chain in practice:** `search_docs({ company: "Firecrawl", query: "click a button before scraping" })` → ranks the *Interact* doc at relevance 1.0 out of 121 pages and hands back the slug + source URL → `get_api_surface` for the exact endpoint/params → WebFetch the page for ground truth. Stale guess → working call, in a couple of calls.

## Also — query your own work history

Local, reads `~/.claude/projects`, nothing leaves your machine:

| tool | what it does |
| --- | --- |
| `recent_work` | what you did most recently — pick up where you left off |
| `query_work` | **fuzzy, ranked** search of your history — by concept, file, or date range |
| `list_sessions` / `get_session` | browse, then open one past session in detail |

---

## Examples — just ask your agent

- *“How do I verify a Stripe webhook signature?”* → `search_docs`
- *“Which Plaid endpoint creates a link token, and what params?”* → `search_docs` → `get_api_surface`
- *“Which API should I use to send transactional email from an agent?”* → `recommend_api`
- *“What did I work on last week?”* → `query_work`

You don’t have to name Nextdev — the agent calls these on its own.

---

## Local‑first & private

The **work‑history** tools only read files already on your disk (`~/.claude/projects`) and return the result to your own agent — **nothing is uploaded.** The **developer‑API** tools query the hosted Nextdev index over the network (and degrade gracefully when offline). Want worklog‑only, no API tools? `npx nextdev --no-benchmarks`.

## Config

| flag | effect |
| --- | --- |
| `--no-benchmarks` | worklog only — don’t expose the developer‑API tools |
| `--no-inject` | don’t touch `AGENTS.md` / `CLAUDE.md` / `.cursorrules` |
| `--backend-url=URL` | point the API tools at a different / self‑hosted index |
| `--dry-run` / `--yes` | preview every change, write nothing / auto‑confirm |

Server env: `NEXTDEV_DISABLE_BENCHMARKS=1` (worklog only), `NEXTDEV_MCP_URL` (override the index endpoint).

## How it works

The developer‑API tools forward to the hosted Nextdev index — the crawling, indexing, and ranking live server‑side; this package proxies. The worklog tools run locally with **lazy cut‑on‑read**: when called, the server reads the relevant session transcript(s), cuts the noise (thinking blocks, tool‑result payloads, metadata, sidechains), and returns clean, ranked slices.

## Editor support

Claude Code today (the worklog reads `~/.claude/projects/**.jsonl`). Codex and Cursor are on the roadmap.

## License

MIT © Nextdev Labs · [github.com/nextdev-labs/mcp](https://github.com/nextdev-labs/mcp)
