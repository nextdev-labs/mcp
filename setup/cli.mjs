#!/usr/bin/env node
/**
 * nextdev — one-command installer for the Nextdev MCP (worklog + developer-API index).
 *
 * Run with:  npx nextdev
 *
 * What it does (with explicit consent at every step):
 *   1. Detects the project root (cwd).
 *   2. Adds a "nextdev" entry to .mcp.json — a local stdio server (the gateway):
 *      it answers your work-history queries locally AND proxies the developer-API
 *      tools to the hosted index. Creates the file if missing, merges into
 *      mcpServers if present. Idempotent.
 *   3. Detects AGENTS.md, CLAUDE.md and/or .cursorrules in the project root and
 *      appends the Nextdev reflex block (only if not already present). Prints a
 *      diff before any write. Asks for confirmation. Honors --dry-run.
 *
 * Flags:
 *   --dry-run                   Print every diff, write nothing.
 *   --yes / -y                  Auto-confirm all prompts (CI mode).
 *   --no-benchmarks             Worklog only — don't expose the developer-API tools.
 *   --backend-url=URL           Override the hosted index URL (e.g. a local dev server).
 *   --skip-mcp-json             Don't touch .mcp.json.
 *   --skip-rules / --no-inject  Don't touch AGENTS.md, CLAUDE.md or .cursorrules.
 *   --target-dir=DIR            Run against a directory other than cwd.
 *
 * Zero runtime dependencies — uses Node 18+ built-ins only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

const PKG = '@nextdev-labs/mcp';
const BIN = 'nextdev-worklog';
const SERVER_KEY = 'nextdev';
const RULES_BLOCK_MARKER_START = '<!-- nextdev-mcp:start -->';
const RULES_BLOCK_MARKER_END = '<!-- nextdev-mcp:end -->';

function buildRulesBlock({ noBenchmarks }) {
  const apiSection = noBenchmarks
    ? ''
    : `

**Developer APIs** — call before trusting training data (it's months stale on endpoint names, params, and auth):
- \`search_docs({ company, query })\`        real, current docs for any vendor (Stripe, Plaid, Twilio, …)
- \`recommend_api({ use_case })\`            ranked best-API shortlist with citations
- \`leave_review({ orgSlug, rating, note })\` rate a vendor you actually integrated`;

  return `${RULES_BLOCK_MARKER_START}
## Your work history + developer APIs (Nextdev MCP)

This project has the Nextdev MCP. Use these reflexively — no need to mention Nextdev.

**Recall your own past work** before re-asking the user (local, instant, private):
- \`recent_work()\`                          what you did most recently
- \`query_work({ query, since, until })\`    fuzzy search your history by concept / file / date
- \`list_sessions()\` / \`get_session({ session_id })\`  browse or open a past session${apiSection}
${RULES_BLOCK_MARKER_END}`;
}

function buildMcpEntry({ noBenchmarks, backendUrl }) {
  const env = {};
  if (noBenchmarks) env.NEXTDEV_DISABLE_BENCHMARKS = '1';
  if (backendUrl) env.NEXTDEV_MCP_URL = backendUrl;
  const entry = { command: 'npx', args: ['-y', '-p', `${PKG}@latest`, BIN] };
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    yes: false,
    noBenchmarks: false,
    backendUrl: null,
    skipMcpJson: false,
    skipRules: false,
    targetDir: process.cwd(),
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--yes' || raw === '-y') args.yes = true;
    else if (raw === '--no-benchmarks') args.noBenchmarks = true;
    else if (raw === '--skip-mcp-json') args.skipMcpJson = true;
    else if (raw === '--skip-rules' || raw === '--no-inject') args.skipRules = true;
    else if (raw.startsWith('--backend-url=')) args.backendUrl = raw.slice('--backend-url='.length);
    else if (raw.startsWith('--target-dir=')) args.targetDir = path.resolve(raw.slice('--target-dir='.length));
    else if (raw === '--help' || raw === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`nextdev — install the Nextdev MCP (worklog + developer-API index) into this project.

Usage:
  npx nextdev [flags]

Flags:
  --dry-run                 Print every diff, write nothing.
  --yes, -y                 Auto-confirm all prompts (CI mode).
  --no-benchmarks           Worklog only — don't expose the developer-API tools.
  --backend-url=URL         Override the hosted index URL (e.g. a local dev server).
  --skip-mcp-json           Don't touch .mcp.json.
  --skip-rules, --no-inject Don't touch AGENTS.md, CLAUDE.md or .cursorrules.
  --target-dir=DIR          Run against a directory other than cwd.
  --help, -h                Show this help.

What this writes (with prompt before each):
  • .mcp.json              Adds a local "nextdev" stdio server (the gateway).
  • AGENTS.md              Appends a Nextdev reflex block (cross-tool standard).
  • CLAUDE.md              Appends a Nextdev reflex block, if file exists.
  • .cursorrules           Appends a Nextdev reflex block, if file exists.

Source: https://github.com/nextdev-labs/mcp`);
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirm(question, { yes }) {
  if (yes) {
    console.log(`${question} y (auto)`);
    return true;
  }
  const answer = await prompt(`${question} [y/N] `);
  return answer === 'y' || answer === 'yes';
}

function printDiff(label, before, after) {
  console.log(`\n--- ${label} (before) ---`);
  console.log(before === null ? '(file does not exist)' : before.slice(-400));
  console.log(`\n+++ ${label} (after) +++`);
  console.log(after.slice(-600));
  console.log();
}

// ─── .mcp.json (Claude Code) ─────────────────────────────────────────────────

async function setupMcpJson(targetDir, args) {
  const filePath = path.join(targetDir, '.mcp.json');
  const desiredEntry = buildMcpEntry(args);

  const current = await readFileOrNull(filePath);
  let json;
  if (current === null) {
    json = { mcpServers: { [SERVER_KEY]: desiredEntry } };
  } else {
    try {
      json = JSON.parse(current);
    } catch {
      console.error(`⚠️  ${filePath} exists but isn't valid JSON. Skipping to avoid clobbering.`);
      return { changed: false, skipped: true };
    }
    json.mcpServers = json.mcpServers || {};
    if (JSON.stringify(json.mcpServers[SERVER_KEY]) === JSON.stringify(desiredEntry)) {
      console.log(`✓ .mcp.json already has the Nextdev entry. No change.`);
      return { changed: false, skipped: false };
    }
    json.mcpServers[SERVER_KEY] = desiredEntry;
  }

  const next = JSON.stringify(json, null, 2) + '\n';
  printDiff('.mcp.json', current, next);

  if (args.dryRun) {
    console.log('(dry-run — no write)');
    return { changed: false, skipped: false };
  }

  const ok = await confirm('Write this .mcp.json?', args);
  if (!ok) {
    console.log('Skipped .mcp.json.');
    return { changed: false, skipped: true };
  }

  await fs.writeFile(filePath, next, 'utf8');
  console.log(`✓ Wrote ${filePath}`);
  return { changed: true, skipped: false };
}

// ─── AGENTS.md / CLAUDE.md / .cursorrules rules block ────────────────────────

async function appendRulesBlock(filePath, fileLabel, args, { allowCreate }) {
  const exists = await fileExists(filePath);
  if (!exists && !allowCreate) {
    console.log(`(no ${fileLabel} in this project — skipping)`);
    return { changed: false, skipped: true };
  }

  const current = exists ? await fs.readFile(filePath, 'utf8') : '';
  if (current.includes(RULES_BLOCK_MARKER_START)) {
    console.log(`✓ ${fileLabel} already has the Nextdev rules block. No change.`);
    return { changed: false, skipped: false };
  }

  const block = buildRulesBlock(args);
  const sep = current.length === 0 || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const next = `${current}${sep}${block}\n`;

  printDiff(fileLabel, exists ? current : null, next);

  if (args.dryRun) {
    console.log('(dry-run — no write)');
    return { changed: false, skipped: false };
  }

  const action = exists ? `Append the rules block to ${fileLabel}?` : `Create ${fileLabel} with the rules block?`;
  const ok = await confirm(action, args);
  if (!ok) {
    console.log(`Skipped ${fileLabel}.`);
    return { changed: false, skipped: true };
  }

  await fs.writeFile(filePath, next, 'utf8');
  console.log(`✓ ${exists ? 'Updated' : 'Created'} ${filePath}`);
  return { changed: true, skipped: false };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const target = args.targetDir;

  console.log(`nextdev — installing the Nextdev MCP into ${target}\n`);
  if (args.dryRun) console.log('(dry-run mode — nothing will be written)\n');
  if (args.noBenchmarks) console.log('(worklog-only — developer-API tools disabled)\n');

  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) {
      console.error(`✗ ${target} is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`✗ ${target} does not exist.`);
    process.exit(1);
  }

  const results = [];

  if (!args.skipMcpJson) {
    results.push(['.mcp.json', await setupMcpJson(target, args)]);
  }

  if (!args.skipRules) {
    const ruleFiles = [
      { path: path.join(target, 'AGENTS.md'), label: 'AGENTS.md', key: 'a' },
      { path: path.join(target, 'CLAUDE.md'), label: 'CLAUDE.md', key: 'c' },
      { path: path.join(target, '.cursorrules'), label: '.cursorrules', key: 'r' },
    ];
    const present = [];
    for (const f of ruleFiles) {
      if (await fileExists(f.path)) present.push(f);
    }

    if (present.length > 0) {
      for (const f of present) {
        results.push([f.label, await appendRulesBlock(f.path, f.label, args, { allowCreate: false })]);
      }
    } else {
      console.log('\n(no AGENTS.md / CLAUDE.md / .cursorrules in this project — would you like one?)');
      const which = args.yes
        ? 'a'
        : await prompt('Create [a]GENTS.md, [c]LAUDE.md, [r] .cursorrules, all [b], or [s]kip? ');
      const wantAll = which === 'b' || which === 'both';
      for (const f of ruleFiles) {
        if (wantAll || which === f.key) {
          results.push([f.label, await appendRulesBlock(f.path, f.label, args, { allowCreate: true })]);
        }
      }
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n─── Summary ─────────────────────────────────────────');
  for (const [label, r] of results) {
    const tag = r.changed ? '✓ changed' : r.skipped ? '— skipped' : '✓ no change';
    console.log(`  ${tag.padEnd(12)} ${label}`);
  }
  console.log('\nDone. Restart your editor (or start a fresh session) for the MCP to register.');
  console.log('Try it: ask your agent "what did I work on recently?" — or about any third-party API.\n');
  console.log('Docs: https://github.com/nextdev-labs/mcp');
}

main().catch((e) => {
  console.error(`\n✗ nextdev failed: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
