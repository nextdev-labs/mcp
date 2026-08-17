// Off-device replication of the local archive to a GCS bucket.
//
// WHY NOT SHELL OUT TO `gcloud`: an MCP server is spawned by the client (Claude
// Code, Cursor) with a reduced environment. Verified on this machine — `gcloud` is
// on the user's interactive PATH but NOT on a minimal subprocess PATH, so
// `gcloud storage cp` would fail silently every sweep. So we speak the GCS JSON API
// directly, using only node:crypto and node:https. Zero dependencies, matching the
// rest of this package.
//
// AUTH: service-account JWT (RS256) exchanged for an access token, cached in memory
// until just before expiry. The key never leaves the machine; no token touches disk.
//
// WRITES ARE CREATE-ONLY: every object name embeds a content hash and is uploaded
// with ifGenerationMatch=0, so an object is written once and never overwritten. That
// is what lets the credential hold *no* delete permission — a compromised machine
// can add to the vault but cannot destroy it. A 412 (already exists) is success, not
// an error, which also makes the sync idempotent if the manifest is ever lost.
//
// FAILURE POLICY: replication is best-effort and must never break local archiving or
// slow down `initialize`. Every failure is caught and recorded so `worklog_health`
// can report it — a silent uploader is worse than no uploader.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as zlib from 'zlib';
import { createSign, createHash } from 'crypto';
import { scanLine } from './redact.js';

const NEXTDEV_ROOT = path.join(os.homedir(), '.nextdev', 'worklog');
const CONFIG_FILE = path.join(NEXTDEV_ROOT, 'vault.json');
const MANIFEST = path.join(NEXTDEV_ROOT, 'vault-manifest.json');
const GZ = '.jsonl.gz';

// Bounds per sweep so a large backlog drains over several runs instead of stalling
// one. Leftovers are picked up on the next sweep.
const MAX_BYTES_PER_SWEEP = 512 * 1024 * 1024;
const MAX_MS_PER_SWEEP = 5 * 60_000;
const MANIFEST_FLUSH_EVERY = 25;

export interface VaultConfig {
  bucket: string;
  keyFile: string;
  prefix: string;
}

export interface VaultStats {
  configured: boolean;
  uploaded: number;
  skipped: number;
  failed: { name: string; error: string }[];
  dirty: string[];        // withheld because they still contain credential material
  bytes: number;
  durationMs: number;
  budgetHit: boolean;
}

/** Config from ~/.nextdev/worklog/vault.json, or env override. Absent → disabled. */
export function loadConfig(): VaultConfig | null {
  const envBucket = process.env.NEXTDEV_VAULT_BUCKET;
  const envKey = process.env.NEXTDEV_VAULT_KEY;
  if (envBucket && envKey) {
    return { bucket: envBucket, keyFile: envKey, prefix: process.env.NEXTDEV_VAULT_PREFIX || 'v1' };
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!c.bucket || !c.keyFile) return null;
    return { bucket: c.bucket, keyFile: c.keyFile, prefix: c.prefix || 'v1' };
  } catch { return null; }
}

// ── auth ──────────────────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function request(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body?: string | Buffer,
  timeoutMs = 120_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end(body);
  });
}

/** Sign a service-account JWT and exchange it for an OAuth access token. */
async function getToken(cfg: VaultConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const key = JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8'));
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    aud: key.token_uri,
    iat,
    exp: iat + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();
  const res = await request('POST', key.token_uri, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': String(Buffer.byteLength(body)),
  }, body, 30_000);
  if (res.status !== 200) throw new Error(`token exchange ${res.status}: ${res.body.slice(0, 200)}`);
  const parsed = JSON.parse(res.body);
  // Refresh a minute early so a long sweep cannot expire mid-flight.
  cachedToken = { token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in - 60) * 1000 };
  return cachedToken.token;
}

// ── object I/O ────────────────────────────────────────────────────────────────

/** Create-only upload. Returns 'created' | 'exists'. Throws on real failure. */
async function putObject(
  cfg: VaultConfig, token: string, name: string, data: Buffer, contentType: string,
): Promise<'created' | 'exists'> {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o`
    + `?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`;
  const res = await request('POST', url, {
    Authorization: `Bearer ${token}`,
    'Content-Type': contentType,
    'Content-Length': String(data.length),
  }, data);
  if (res.status === 200) return 'created';
  // 412 = precondition failed = the object is already there. Content-addressed names
  // mean identical bytes, so this is success and keeps the sync idempotent.
  if (res.status === 412) return 'exists';
  throw new Error(`upload ${res.status}: ${res.body.slice(0, 200)}`);
}

/** Live object count under the prefix — ground truth for a health check. */
export async function countObjects(cfg: VaultConfig): Promise<number> {
  const token = await getToken(cfg);
  let pageToken = '';
  let n = 0;
  do {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o`
      + `?prefix=${encodeURIComponent(cfg.prefix + '/')}&fields=items(name),nextPageToken&maxResults=1000`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await request('GET', url, { Authorization: `Bearer ${token}` }, undefined, 60_000);
    if (res.status !== 200) throw new Error(`list ${res.status}: ${res.body.slice(0, 160)}`);
    const parsed = JSON.parse(res.body);
    for (const it of parsed.items || []) if (String(it.name).endsWith(GZ)) n++;
    pageToken = parsed.nextPageToken || '';
  } while (pageToken);
  return n;
}

// ── manifest ──────────────────────────────────────────────────────────────────

type Manifest = Record<string, string[]>;

function loadManifest(): Manifest {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}
function saveManifest(m: Manifest): void {
  try {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    const tmp = `${MANIFEST}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
    fs.renameSync(tmp, MANIFEST);
  } catch { /* a lost manifest costs one redundant pass, not correctness */ }
}

/** Same keying as the Python backfill tool so both share one manifest. */
function manifestKey(stem: string): string {
  const parts = stem.split(path.sep);
  if (parts[0] === '_claude') return '_history';
  return parts.length === 2 ? parts[1] : stem;
}

function sha12(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function walkGz(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkGz(p, out);
    else if (e.name.endsWith(GZ)) out.push(p);
  }
  return out;
}

/** Defence in depth: capture-time redaction should already have cleaned this, but
 *  nothing is shipped off-device without being re-checked. */
function containsSecret(gzPath: string): boolean {
  try {
    const txt = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
    for (const line of txt.split('\n')) if (line && scanLine(line) > 0) return true;
  } catch { return false; }
  return false;
}

// ── the sweep-time sync ───────────────────────────────────────────────────────

/**
 * Replicate anything in the local archive that is not yet in the vault.
 * Never throws. Bounded per call so a backlog drains across sweeps.
 */
export async function syncVault(archiveRoot: string): Promise<VaultStats> {
  const t0 = Date.now();
  const stats: VaultStats = {
    configured: false, uploaded: 0, skipped: 0, failed: [], dirty: [],
    bytes: 0, durationMs: 0, budgetHit: false,
  };
  const cfg = loadConfig();
  if (!cfg) { stats.durationMs = Date.now() - t0; return stats; }
  stats.configured = true;

  let token: string;
  try { token = await getToken(cfg); }
  catch (e: any) {
    stats.failed.push({ name: '*auth*', error: String(e?.message || e).slice(0, 200) });
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const man = loadManifest();
  let sinceFlush = 0;

  for (const p of walkGz(archiveRoot)) {
    if (stats.bytes >= MAX_BYTES_PER_SWEEP || Date.now() - t0 >= MAX_MS_PER_SWEEP) {
      stats.budgetHit = true;
      break;
    }
    let buf: Buffer;
    try { buf = fs.readFileSync(p); } catch { continue; }
    const stem = path.relative(archiveRoot, p).slice(0, -GZ.length);
    const key = manifestKey(stem);
    const h = sha12(buf);
    if ((man[key] || []).includes(h)) { stats.skipped++; continue; }

    if (containsSecret(p)) { stats.dirty.push(path.basename(p)); continue; }

    try {
      await putObject(cfg, token, `${cfg.prefix}/${stem}/${h}${GZ}`, buf, 'application/gzip');
      const metaPath = p.replace(GZ, '.meta.json');
      if (fs.existsSync(metaPath)) {
        await putObject(cfg, token, `${cfg.prefix}/${stem}/${h}.meta.json`,
          fs.readFileSync(metaPath), 'application/json');
      }
      (man[key] = man[key] || []).push(h);
      stats.uploaded++;
      stats.bytes += buf.length;
      if (++sinceFlush >= MANIFEST_FLUSH_EVERY) { saveManifest(man); sinceFlush = 0; }
    } catch (e: any) {
      const msg = String(e?.message || e);
      stats.failed.push({ name: path.basename(p), error: msg.slice(0, 200) });
      // A 401 mid-sweep means the cached token died; drop it so the next attempt retries clean.
      if (msg.includes('401')) cachedToken = null;
    }
  }

  // Snapshot history.jsonl (append-only, never purged — the most valuable single file).
  try {
    const history = path.join(os.homedir(), '.claude', 'history.jsonl');
    if (!stats.budgetHit && fs.existsSync(history)) {
      const raw = fs.readFileSync(history);
      const h = sha12(raw);
      if (!(man['_history'] || []).includes(h)) {
        const gz = zlib.gzipSync(raw);
        await putObject(cfg, token, `${cfg.prefix}/_claude/history/${h}${GZ}`, gz, 'application/gzip');
        (man['_history'] = man['_history'] || []).push(h);
        stats.uploaded++;
        stats.bytes += gz.length;
      }
    }
  } catch (e: any) {
    stats.failed.push({ name: 'history.jsonl', error: String(e?.message || e).slice(0, 200) });
  }

  saveManifest(man);
  stats.durationMs = Date.now() - t0;
  return stats;
}

/** Manifest-derived object count — cheap, no network. */
export function manifestCount(): number {
  return Object.values(loadManifest()).reduce((n, v) => n + (v?.length || 0), 0);
}

/** Local archive files not yet recorded as uploaded. */
export function pendingCount(archiveRoot: string): number {
  const man = loadManifest();
  let pending = 0;
  for (const p of walkGz(archiveRoot)) {
    let buf: Buffer;
    try { buf = fs.readFileSync(p); } catch { continue; }
    const stem = path.relative(archiveRoot, p).slice(0, -GZ.length);
    if (!(man[manifestKey(stem)] || []).includes(sha12(buf))) pending++;
  }
  return pending;
}
