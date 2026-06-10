# Nextdev MCP — query your own AI work history

[![npm version](https://img.shields.io/npm/v/@nextdev-labs/mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@nextdev-labs/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![local-first](https://img.shields.io/badge/local--first-read--only-7DEFA1)](#local-first--private)

Your coding agent (Claude Code, …) already writes a **complete transcript of every session to disk**. This MCP reads it, cuts the noise, and lets your agent recall **what you actually did** — so it stops asking you to re-explain past work, and you never grep a multi‑megabyte JSONL again.

100% local. Read‑only. **Zero dependencies.** Plus an optional developer‑API index (docs, rankings, reviews) so your agent stops guessing third‑party endpoints from stale training data.

```bash
npx nextdev
```

One command registers the MCP in your editor and appends a short reflex block to your `AGENTS.md` / `CLAUDE.md` / `.cursorrules`, so your agent uses it automatically. Restart your editor (or start a fresh session) and ask: **“what did I work on recently?”**

---

## What you get

**Work history** — local, reads `~/.claude/projects`, nothing leaves your machine:

| tool | what it does |
| --- | --- |
| `recent_work` | what you did most recently, newest first |
| `query_work` | **fuzzy, ranked** search of your history — by concept, file, or date range |
| `list_sessions` | an index of your past sessions (date, turn count, files touched) |
| `get_session` | the cut log of one session — prompt + what the agent did + tool trace |

**Developer APIs** — proxied from the hosted Nextdev index (optional; `--no-benchmarks` to skip):

| tool | what it does |
| --- | --- |
| `search_docs` | real, current docs for any vendor (Stripe, Plaid, Twilio, Persona, …) |
| `recommend_api` | ranked best‑API shortlist for a use case, with citations |
| `leave_review` | rate a vendor you actually integrated |

---

## Examples — just ask your agent

- *“What did I work on last week?”* → `query_work` with a date window
- *“Find where I set up the auth flow.”* → `query_work`
- *“Walk me through that big refactor session.”* → `list_sessions` → `get_session`
- *“Which API should I use to send transactional email from an agent?”* → `recommend_api`
- *“Get me Stripe’s webhook‑signing docs.”* → `search_docs`

The agent calls these on its own — you don’t have to name Nextdev.

---

## Why it beats re‑explaining

Most “memory” tools make the model summarize each turn — lossy, token‑costly, and easy to forget. This reads the **verbatim** transcript your agent already wrote (every prompt, tool call, and file change) and cuts it to the signal **on demand**: a multi‑MB session becomes a few‑KB answer. Nothing runs in the background; there’s nothing to remember to log.

---

## Local‑first & private

The work‑history tools only ever read files already on your disk (`~/.claude/projects`) and return the result to your own agent — **nothing is uploaded.** The developer‑API tools call the hosted index over the network and **degrade gracefully when offline** (you keep the worklog). For a pure‑local install, use `--no-benchmarks`.

---

## Config

Installer flags (`npx nextdev …`):

| flag | effect |
| --- | --- |
| `--no-benchmarks` | worklog only — don’t expose the developer‑API tools |
| `--no-inject` | don’t touch `AGENTS.md` / `CLAUDE.md` / `.cursorrules` |
| `--backend-url=URL` | point the API tools at a different / self‑hosted index |
| `--dry-run` / `--yes` | preview every change, write nothing / auto‑confirm |

Server env vars (set in your MCP config’s `env`):

- `NEXTDEV_DISABLE_BENCHMARKS=1` — worklog only.
- `NEXTDEV_MCP_URL` — override the hosted index endpoint.

---

## How it works

Lazy **cut‑on‑read**: when the agent calls a worklog tool, the server locates the relevant session transcript(s), parses + cuts them (filtering thinking blocks, tool‑result payloads, metadata, and sidechain noise), and returns clean, ranked slices. The developer‑API tools are **forwarded** to the hosted Nextdev index — the ranking logic and data live server‑side; this package only proxies.

## Editor support

Claude Code today (reads `~/.claude/projects/**.jsonl`). Codex and Cursor are on the roadmap — each is a separate transcript reader behind the same tools.

## License

MIT © Nextdev Labs · [github.com/nextdev-labs/mcp](https://github.com/nextdev-labs/mcp)
