// Durable local archive for Claude Code transcripts.
//
// Claude Code purges ~/.claude/projects/<dir>/*.jsonl past `cleanupPeriodDays`
// (default 30, deleted at startup). This snapshots each session — gzipped JSONL +
// a sidecar meta — into a central, durable store so the worklog can still query
// history long after the originals are purged.
//
// Local-first: nothing is uploaded from here. Layout:
//   ~/.nextdev/worklog/archive/<encoded-cwd>/<sessionId>.jsonl.gz
//   ~/.nextdev/worklog/archive/<encoded-cwd>/<sessionId>.meta.json
//   ~/.nextdev/worklog/archive/<encoded-cwd>/<parentSessionId>/subagents/<agentId>.jsonl.gz
//
// Properties:
//   - One file per session (no duplication across sweeps, ever).
//   - Incremental: (re)archived only when the live mtime/size changed, so re-running
//     is cheap and idempotent; it converges to the final transcript.
//   - Atomic writes (temp + rename): concurrent sweeps never leave a torn file.
//   - STREAMED, not slurped — memory is bounded regardless of transcript size, which
//     is why there is no size cap. (There used to be a 50MB one; it silently skipped
//     the largest and most valuable sessions.)
//   - REDACTED on the way in: credentials are stripped per line before gzip, so a
//     secret read into a transcript never reaches the durable copy.
//   - Every skip and failure is recorded to sweep.log — silence was how a 90MB
//     session went unarchived for five weeks without anyone noticing.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { enumerateSessionFiles, parseTurnsFromString } from './transcriptSync.js';
import { redactLine } from './redact.js';
import type { SourceRef, Scope } from './queryEngine.js';

const NEXTDEV_ROOT = path.join(os.homedir(), '.nextdev', 'worklog');
// Overridable so verification runs can target a temp dir and never risk the real archive.
const ARCHIVE_ROOT = process.env.NEXTDEV_ARCHIVE_ROOT || path.join(NEXTDEV_ROOT, 'archive');
const STAMP_FILE = path.join(NEXTDEV_ROOT, '.last-sweep');
const SWEEP_LOG = path.join(NEXTDEV_ROOT, 'sweep.log');
const VAULT_MANIFEST = path.join(NEXTDEV_ROOT, 'vault-manifest.json');
const SWEEP_DEBOUNCE_MS = 60_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const GZ_SUFFIX = '.jsonl.gz';

interface ArchiveMeta {
  sessionId: string;
  cwd: string | null;
  srcMtimeMs: number;
  srcSize: number;
  archivedAt: number;
  bytesRaw: number;
  redactions?: number;
  parentSessionId?: string;
}

export interface SweepStats {
  ts: string;
  scanned: number;
  archived: number;
  redactions: number;
  skipped: { sessionId: string; reason: string }[];
  errors: { sessionId: string; error: string }[];
  durationMs: number;
}

function gzPath(dir: string, id: string): string { return path.join(dir, `${id}${GZ_SUFFIX}`); }
function metaPath(dir: string, id: string): string { return path.join(dir, `${id}.meta.json`); }

function atomicWrite(target: string, data: Buffer | string): void {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function readMeta(dir: string, id: string): ArchiveMeta | null {
  try { return JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf8')) as ArchiveMeta; }
  catch { return null; }
}

/**
 * Stream one transcript into a gzipped, redacted archive file.
 *
 * Line-oriented on purpose: JSONL never splits a secret across lines, so redacting
 * per line is both correct and immune to read-chunk boundaries. `pipeline` handles
 * backpressure, so memory stays flat on a 90MB transcript.
 *
 * Writes to a temp sibling and renames only on success — a crash mid-stream leaves
 * the previous archived copy intact rather than a truncated one.
 */
async function archiveOne(src: string, destGz: string): Promise<{ redactions: number }> {
  const tmp = `${destGz}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let redactions = 0;
  async function* lines() {
    const rl = readline.createInterface({
      input: createReadStream(src),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const r = redactLine(line);
      redactions += r.hits;
      yield r.line + '\n';
    }
  }
  try {
    await pipeline(lines(), zlib.createGzip(), createWriteStream(tmp));
    fs.renameSync(tmp, destGz);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  return { redactions };
}

function appendSweepLog(stats: SweepStats): void {
  try {
    fs.mkdirSync(path.dirname(SWEEP_LOG), { recursive: true });
    try {
      if (fs.statSync(SWEEP_LOG).size > LOG_MAX_BYTES) {
        fs.renameSync(SWEEP_LOG, `${SWEEP_LOG}.1`);
      }
    } catch { /* no log yet */ }
    fs.appendFileSync(SWEEP_LOG, JSON.stringify(stats) + '\n');
  } catch { /* logging must never break a sweep */ }
}

/**
 * Incremental sweep: snapshot every live session whose content changed since it was
 * last archived. Cheap (stat-only) for unchanged sessions. Never throws — but every
 * skip and error is recorded, so "nothing happened" is always explainable.
 */
export async function syncArchive(projectPath: string, scope: Scope = 'global'): Promise<SweepStats> {
  const t0 = Date.now();
  const stats: SweepStats = {
    ts: new Date().toISOString(),
    scanned: 0, archived: 0, redactions: 0, skipped: [], errors: [], durationMs: 0,
  };

  let live: ReturnType<typeof enumerateSessionFiles>;
  try { live = enumerateSessionFiles(projectPath, scope, { includeSubagents: true }); }
  catch (e: any) {
    stats.errors.push({ sessionId: '*', error: `enumerate failed: ${e?.message || e}` });
    stats.durationMs = Date.now() - t0;
    appendSweepLog(stats);
    return stats;
  }

  for (const ref of live) {
    stats.scanned++;
    const id = ref.parentSessionId ? `${ref.parentSessionId}/${ref.sessionId}` : ref.sessionId;
    try {
      const st = fs.statSync(ref.sessionFile);
      // Mirror the on-disk layout relative to the project dir. Subagents therefore
      // nest under their parent (so the relationship survives the purge), and
      // workflow agents — which Claude Code puts a further level down at
      // subagents/workflows/<wf-id>/ — keep that structure too.
      const relDir = path.relative(ref.projectDir, path.dirname(ref.sessionFile));
      const dir = path.join(ARCHIVE_ROOT, path.basename(ref.projectDir), relDir);

      const meta = readMeta(dir, ref.sessionId);
      if (meta && meta.srcMtimeMs >= st.mtimeMs && meta.srcSize === st.size) {
        stats.skipped.push({ sessionId: id, reason: 'unchanged' });
        continue;
      }

      fs.mkdirSync(dir, { recursive: true });
      const { redactions } = await archiveOne(ref.sessionFile, gzPath(dir, ref.sessionId));
      stats.redactions += redactions;

      const m: ArchiveMeta = {
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        srcMtimeMs: st.mtimeMs,
        srcSize: st.size,
        archivedAt: Date.now(),
        bytesRaw: st.size,
        redactions,
        ...(ref.parentSessionId ? { parentSessionId: ref.parentSessionId } : {}),
      };
      atomicWrite(metaPath(dir, ref.sessionId), JSON.stringify(m)); // meta last = commit marker
      stats.archived++;
    } catch (e: any) {
      stats.errors.push({ sessionId: id, error: String(e?.message || e).slice(0, 200) });
    }
  }

  stats.durationMs = Date.now() - t0;
  appendSweepLog(stats);
  return stats;
}

/**
 * Enumerate archived TOP-LEVEL sessions as SourceRefs (lazy: gunzip + parse on
 * demand). Subagent archives live one directory deeper and are deliberately not
 * surfaced here — 991 of them would swamp list_sessions and burn the scan budget.
 * They are captured for durability; exposing them is a later, separate design.
 */
export function enumerateArchived(projectPath: string, scope: Scope = 'global'): SourceRef[] {
  if (!fs.existsSync(ARCHIVE_ROOT)) return [];
  const out: SourceRef[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(ARCHIVE_ROOT); } catch { return []; }

  for (const d of dirs) {
    const dir = path.join(ARCHIVE_ROOT, d);
    let files: string[] = [];
    try { if (!fs.statSync(dir).isDirectory()) continue; files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(GZ_SUFFIX)) continue;   // nested subagent dirs skipped by this test
      const sessionId = f.slice(0, -GZ_SUFFIX.length);
      const meta = readMeta(dir, sessionId);
      const cwd = meta?.cwd ?? null;
      if (scope === 'project' && cwd !== null && cwd !== projectPath) continue;
      const gz = gzPath(dir, sessionId);
      let sortKey = meta?.srcMtimeMs ?? 0;
      if (!sortKey) { try { sortKey = fs.statSync(gz).mtimeMs; } catch { sortKey = 0; } }
      out.push({
        sourceId: 'claude-archive',
        sessionId,
        cwd,
        sortKey,
        loadTurns: () => {
          try { return parseTurnsFromString(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8')); }
          catch { return []; }
        },
      });
    }
  }
  return out;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface HealthReport {
  lastSweep: SweepStats | null;
  archivedSessions: number;
  archivedSubagents: number;
  liveSessions: number;
  vaultObjects: number | null;
  vaultLag: number | null;   // sessions archived locally but not yet in the vault
  archiveRoot: string;
}

/** Everything needed to answer "is my history actually being saved?" */
export function getHealth(projectPath: string): HealthReport {
  let lastSweep: SweepStats | null = null;
  try {
    const txt = fs.readFileSync(SWEEP_LOG, 'utf8').trimEnd();
    const last = txt.slice(txt.lastIndexOf('\n') + 1);
    lastSweep = JSON.parse(last);
  } catch { /* no sweep yet */ }

  let archivedSessions = 0, archivedSubagents = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // Depth allows project/ → session/ → subagents/ → workflows/ → <wf-id>/
      if (e.isDirectory()) { if (depth < 6) walk(path.join(dir, e.name), depth + 1); }
      else if (e.name.endsWith(GZ_SUFFIX)) { if (depth === 1) archivedSessions++; else archivedSubagents++; }
    }
  };
  walk(ARCHIVE_ROOT, 0);

  let liveSessions = 0;
  try { liveSessions = enumerateSessionFiles(projectPath, 'global').length; } catch { /* ignore */ }

  let vaultObjects: number | null = null;
  try {
    const man = JSON.parse(fs.readFileSync(VAULT_MANIFEST, 'utf8'));
    vaultObjects = Object.values(man).reduce((n: number, v: any) => n + (v?.length || 0), 0);
  } catch { /* no vault */ }

  return {
    lastSweep,
    archivedSessions,
    archivedSubagents,
    liveSessions,
    vaultObjects,
    vaultLag: vaultObjects === null ? null : Math.max(0, archivedSessions - vaultObjects),
    archiveRoot: ARCHIVE_ROOT,
  };
}

// ── Debounced, non-blocking trigger (called on every MCP `initialize`) ─────────

let pending: Promise<void> | null = null;

function sweptRecently(): boolean {
  try { return Date.now() - fs.statSync(STAMP_FILE).mtimeMs < SWEEP_DEBOUNCE_MS; }
  catch { return false; }
}
function stampNow(): void {
  try {
    fs.mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
    fs.writeFileSync(STAMP_FILE, String(Date.now()));
  } catch { /* ignore */ }
}

/**
 * Fire a debounced global sweep without blocking the caller. Safe to call on every
 * initialize; skips if another sweep ran in the last minute.
 */
export function maybeSweepArchive(): void {
  if (pending || sweptRecently()) return;
  pending = (async () => {
    try {
      await Promise.resolve();       // let `initialize` respond first
      await syncArchive(process.cwd(), 'global');
    } catch { /* recorded in sweep.log */ }
    finally { stampNow(); pending = null; }
  })();
}

/**
 * Await any in-flight sweep. LOAD-BEARING since the writer became streamed: with
 * synchronous fs a partial write was impossible, but a stream can be cut off by
 * process exit. stdio.ts must await this before exiting.
 */
export async function flushArchive(): Promise<void> {
  if (pending) { try { await pending; } catch { /* ignore */ } }
}
