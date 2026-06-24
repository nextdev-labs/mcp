// Durable local archive for Claude Code transcripts.
//
// Claude Code purges ~/.claude/projects/<dir>/*.jsonl past `cleanupPeriodDays`
// (default 30, deleted at startup). This snapshots each session — gzipped raw
// JSONL + a sidecar meta — into a central, durable store so the worklog can still
// query history long after the originals are purged.
//
// Local-first: nothing is uploaded. Layout:
//   ~/.nextdev/worklog/archive/<encoded-cwd>/<sessionId>.jsonl.gz
//   ~/.nextdev/worklog/archive/<encoded-cwd>/<sessionId>.meta.json
//
// Properties:
//   - One file per sessionId (no duplication across sessions, ever).
//   - Incremental: a session is (re)archived only when its live mtime/size changed,
//     so re-running is cheap and idempotent; it converges to the final transcript.
//   - Atomic writes (temp + rename): concurrent Claude sessions can sweep at once
//     without torn files; readers only ever see fully-written files.
//   - Raw gzipped JSONL (not pre-cut) so future parser improvements re-parse it.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { enumerateSessionFiles, parseTurnsFromString } from './transcriptSync.js';
import type { SourceRef, Scope } from './queryEngine.js';

const ARCHIVE_ROOT = path.join(os.homedir(), '.nextdev', 'worklog', 'archive');
const STAMP_FILE = path.join(os.homedir(), '.nextdev', 'worklog', '.last-sweep');
const SWEEP_DEBOUNCE_MS = 60_000;
// Skip pathologically large transcripts (sync gzip would block); tunable.
const MAX_BYTES = Number(process.env.NEXTDEV_ARCHIVE_MAX_BYTES) || 50 * 1024 * 1024;
const GZ_SUFFIX = '.jsonl.gz';

interface ArchiveMeta {
  sessionId: string;
  cwd: string | null;
  srcMtimeMs: number;
  srcSize: number;
  archivedAt: number;
  bytesRaw: number;
}

function gzPath(dir: string, sessionId: string): string { return path.join(dir, `${sessionId}${GZ_SUFFIX}`); }
function metaPath(dir: string, sessionId: string): string { return path.join(dir, `${sessionId}.meta.json`); }

/** Write to a temp sibling then rename — atomic on the same filesystem, so a crash
 *  or a concurrent writer never leaves a half-written (unreadable) file. */
function atomicWrite(target: string, data: Buffer | string): void {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function readMeta(dir: string, sessionId: string): ArchiveMeta | null {
  try { return JSON.parse(fs.readFileSync(metaPath(dir, sessionId), 'utf8')) as ArchiveMeta; }
  catch { return null; }
}

/**
 * Incremental sweep: snapshot every live session whose content changed since it was
 * last archived. Cheap (stat-only) for unchanged sessions. Never throws.
 */
export function syncArchive(projectPath: string, scope: Scope = 'global'): { archived: number; scanned: number } {
  let archived = 0;
  let scanned = 0;
  let live: ReturnType<typeof enumerateSessionFiles>;
  try { live = enumerateSessionFiles(projectPath, scope); } catch { return { archived, scanned }; }

  for (const ref of live) {
    scanned++;
    try {
      const st = fs.statSync(ref.sessionFile);
      if (st.size > MAX_BYTES) continue;
      // Archive subdir mirrors Claude's own encoded project dir name.
      const dir = path.join(ARCHIVE_ROOT, path.basename(ref.projectDir));
      const meta = readMeta(dir, ref.sessionId);
      if (meta && meta.srcMtimeMs >= st.mtimeMs && meta.srcSize === st.size) continue; // unchanged → skip

      const rawBuf = fs.readFileSync(ref.sessionFile);
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(gzPath(dir, ref.sessionId), zlib.gzipSync(rawBuf)); // gz first…
      const m: ArchiveMeta = {
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        srcMtimeMs: st.mtimeMs,
        srcSize: st.size,
        archivedAt: Date.now(),
        bytesRaw: rawBuf.length,
      };
      atomicWrite(metaPath(dir, ref.sessionId), JSON.stringify(m)); // …meta last (commit marker)
      archived++;
    } catch {
      /* best-effort per session */
    }
  }
  return { archived, scanned };
}

/**
 * Enumerate archived sessions as SourceRefs (lazy: loadTurns gunzips + parses on
 * demand). For 'project' scope, filter by the meta's recorded cwd.
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
      if (!f.endsWith(GZ_SUFFIX)) continue;
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

// ── Debounced, non-blocking trigger (called on every MCP `initialize`) ──────────

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
 * Fire a debounced global sweep without blocking the caller (deferred a tick so
 * `initialize` returns immediately). The actual copy uses synchronous fs, so each
 * file is fully written-or-not regardless of process-exit timing. Safe to call on
 * every initialize; skips if another sweep ran in the last minute.
 */
export function maybeSweepArchive(): void {
  if (pending || sweptRecently()) return;
  pending = (async () => {
    try {
      await Promise.resolve(); // yield so we don't block the initialize response
      syncArchive(process.cwd(), 'global');
    } catch {
      /* best-effort */
    } finally {
      stampNow();
      pending = null;
    }
  })();
}

/** Await any in-flight sweep — call before the stdio process exits so a sweep
 *  kicked off by the last request finishes its writes. */
export async function flushArchive(): Promise<void> {
  if (pending) { try { await pending; } catch { /* ignore */ } }
}
