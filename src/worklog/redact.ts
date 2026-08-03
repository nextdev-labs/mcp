// Capture-time credential redaction for transcripts entering the durable archive.
//
// WHY LINE-LOCAL: transcripts are JSONL, and a PEM block inside a JSON string uses
// escaped "\n" rather than real newlines — so no secret ever spans a line boundary.
// (Verified against the real archive: every BEGIN..END pair lives on one line.)
// That lets us redact one line at a time, which is what makes the streaming archive
// writer safe — a secret can never be split across two read chunks.
//
// SCOPE, stated honestly. This is pattern-based: known credential shapes, KEY=value
// assignments (which covers a `.env` file read verbatim into a tool_result), and PEM
// bodies. It does NOT catch a secret echoed bare with no recognisable shape and no
// assignment — that needs a corpus-wide value sweep, which is the job of the periodic
// repair tool (~/.nextdev/vault-scrub.py), not of the write path.
//
// Redactions are self-describing: [REDACTED:stripe-live:a1b2c3d4]. The transcript
// stays readable and you can still tell what kind of secret was there, which matters
// for an archive meant to record how you worked.

import { createHash } from 'crypto';

interface Shape {
  label: string;
  rx: RegExp;      // global — used with .replace()
  group: number;   // which capture group holds the secret (0 = whole match)
}

// Prefix-anchored so ordinary prose ("sk-" in a sentence) never matches.
const SHAPES: Shape[] = [
  { label: 'anthropic', rx: /sk-ant-[A-Za-z0-9_-]{32,}/g, group: 0 },
  { label: 'openai', rx: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, group: 0 },
  { label: 'stripe-live', rx: /sk_live_[A-Za-z0-9]{20,}/g, group: 0 },
  { label: 'stripe-test', rx: /sk_test_[A-Za-z0-9]{20,}/g, group: 0 },
  { label: 'stripe-whsec', rx: /whsec_[A-Za-z0-9]{20,}/g, group: 0 },
  { label: 'perplexity', rx: /pplx-[A-Za-z0-9]{30,}/g, group: 0 },
  { label: 'pinecone', rx: /pcsk_[A-Za-z0-9_-]{30,}/g, group: 0 },
  { label: 'replicate', rx: /r8_[A-Za-z0-9]{30,}/g, group: 0 },
  { label: 'resend', rx: /\bre_[A-Za-z0-9_-]{20,}/g, group: 0 },
  { label: 'agentmail', rx: /\bam_[A-Za-z0-9]{30,}/g, group: 0 },
  { label: 'github-pat', rx: /gh[pousr]_[A-Za-z0-9]{30,}/g, group: 0 },
  // Also matches NEXT_PUBLIC_FIREBASE_API_KEY, which is public by design. Redacted
  // anyway: a strict shape rule beats an allowlist that could mask a genuinely
  // private Google key sitting next to the words NEXT_PUBLIC.
  { label: 'google-api', rx: /AIza[0-9A-Za-z_-]{35}/g, group: 0 },
  { label: 'elevenlabs', rx: /\bsk_[0-9a-f]{40,}/g, group: 0 },
  { label: 'supadata', rx: /\bsd_[A-Za-z0-9]{28,}/g, group: 0 },
  { label: 'slack', rx: /xox[baprs]-[A-Za-z0-9-]{20,}/g, group: 0 },
  { label: 'aws-akid', rx: /AKIA[0-9A-Z]{16}/g, group: 0 },
  { label: 'jwt', rx: /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, group: 0 },
  { label: 'redis-cred', rx: /(rediss?:\/\/[^:\s"\\]+:)([A-Za-z0-9_-]{20,})(@)/g, group: 2 },
  { label: 'pg-cred', rx: /(postgres(?:ql)?:\/\/[^:\s"\\]+:)([^@\s"\\]{8,})(@)/g, group: 2 },
];

// One cheap test to decide whether any shape regex is worth running on this line.
const SNIFF = /sk-|sk_|whsec_|pplx-|pcsk_|r8_|\bre_|\bam_|gh[pousr]_|AIza|\bsd_|xox|AKIA|eyJ|redis|postgres/;

// PEM bodies. Line-local, so [\s\S] cannot run past the current line.
const PEM = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]+?)(-----END [A-Z ]*PRIVATE KEY-----)/g;

// Assignment separator: '=', '="', or '=\"'. It must NEVER match a lone backslash —
// doing so eats the escape in an encoded "\n" and captures the FOLLOWING variable
// name as if it were the value, which corrupts the line on replacement.
const SEP = String.raw`(?:=(?:\\"|")?)`;
// `.env` file contents arrive as line-numbered Read output:  "    12→FOO=bar"
const ENV_ASSIGN = new RegExp(String.raw`(\s*\d+→)([A-Z][A-Z0-9_]{2,60})(${SEP})([^\n"\\]{6,})`, 'g');
// Bare assignments (shell exports, code, echoed commands)
const BARE_ASSIGN = new RegExp(String.raw`\b([A-Z][A-Z0-9_]{2,60})(${SEP})([A-Za-z0-9_\-./+:@]{16,})`, 'g');

const SECRET_NAME = /(?:API_KEY|APIKEY|_KEY|KEY_ONE|_TOKEN|TOKEN|_SECRET|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS|_DSN|KV_URL|DATABASE_URL|REDIS_URL)$/i;
const NAME_ALLOWLIST = /^(?:.*_PRICE_ID|.*_PRICE|.*_PROJECT_ID|.*_INDEX_NAME|.*_ENVIRONMENT|.*_WORKSPACE_ID|.*_ACCOUNT_ID|.*_ORG_ID|.*_CLIENT_EMAIL|.*_API_URL|.*_REST_API_URL|ADMIN_EMAILS|.*_BASE_URL)$/i;

const IDENTIFIER_LIKE = /^[A-Za-z]?[A-Z0-9_]{6,}$/;
const WORDY = /^[a-z][a-z0-9_\-.]*$/;
const MIN_LEN = 16;

/**
 * Gate for values discovered via assignment parsing. Shape matches are trusted
 * (their prefixes are unambiguous); assignment values are not, so they must look
 * like real credential material or they are left alone.
 */
function plausible(v: string): boolean {
  if (v.length < MIN_LEN) return false;
  if (v.startsWith('$') || v.includes('${') || v.includes('}')) return false;  // shell interpolation
  if (IDENTIFIER_LIKE.test(v)) return false;   // an ALL_CAPS variable name, not a value
  if (WORDY.test(v)) return false;             // lowercase words, paths, filenames
  if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('/') || v.startsWith('./')) return false;
  if ((v.match(/\//g) || []).length >= 3) return false;
  const classes = Number(/[a-z]/.test(v)) + Number(/[A-Z]/.test(v)) + Number(/[0-9]/.test(v));
  return classes >= 2;                          // require some real entropy
}

function mark(label: string, secret: string): string {
  return `[REDACTED:${label}:${createHash('sha256').update(secret).digest('hex').slice(0, 8)}]`;
}

// IDEMPOTENCE. Without this, running the redactor over already-redacted text
// re-matches its own markers — ENV_ASSIGN's value charset ([^\n"\\]) happily
// swallows "[REDACTED:env:FOO:abc12345]" and replaces it with a fresh marker
// carrying a different hash. Nothing is lost, but the output churns on every pass,
// which (a) breaks scan-based "is this archive clean?" checks with false positives
// and (b) would change the content hash of an unchanged session, causing endless
// re-uploads to the vault. A redacted line must be a fixed point.
const ALREADY_REDACTED = /\[REDACTED:[^\]]*\]/;

export interface RedactResult {
  line: string;
  hits: number;
  labels: string[];
}

/**
 * Redact one JSONL line. Returns the line unchanged (hits: 0) when nothing matches,
 * which is the overwhelmingly common case — the sniff test keeps that path cheap.
 *
 * Replacement text is JSON-safe (no quotes, no backslashes), so a redacted line
 * remains valid JSON.
 */
export function redactLine(line: string): RedactResult {
  let out = line;
  let hits = 0;
  const labels: string[] = [];

  if (SNIFF.test(out)) {
    for (const s of SHAPES) {
      s.rx.lastIndex = 0;
      out = out.replace(s.rx, (whole, ...groups) => {
        const secret = s.group === 0 ? whole : (groups[s.group - 1] as string);
        if (!secret) return whole;
        hits++;
        labels.push(s.label);
        return whole.replace(secret, mark(s.label, secret));
      });
    }
  }

  if (out.includes('PRIVATE KEY-----')) {
    PEM.lastIndex = 0;
    out = out.replace(PEM, (whole, begin: string, body: string, end: string) => {
      if (ALREADY_REDACTED.test(body)) return whole;   // fixed point
      hits++;
      labels.push('private-key');
      return begin + mark('private-key', body.slice(0, 64)) + end;
    });
  }

  if (out.includes('=')) {
    for (const [rx, nameIdx, valIdx] of [
      [ENV_ASSIGN, 2, 4] as const,
      [BARE_ASSIGN, 1, 3] as const,
    ]) {
      rx.lastIndex = 0;
      out = out.replace(rx, (whole, ...groups) => {
        const name = groups[nameIdx - 1] as string;
        const val = groups[valIdx - 1] as string;
        if (!name || !val) return whole;
        if (ALREADY_REDACTED.test(val)) return whole;   // fixed point
        if (NAME_ALLOWLIST.test(name) || !SECRET_NAME.test(name)) return whole;
        if (!plausible(val)) return whole;
        hits++;
        labels.push(`env:${name}`);
        return whole.replace(val, mark(`env:${name}`, val));
      });
    }
  }

  return { line: out, hits, labels };
}

/** Detect-only — used by verification and the health tool. Never mutates. */
export function scanLine(line: string): number {
  return redactLine(line).hits;
}
