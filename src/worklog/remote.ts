/**
 * Leaderboard proxy — the "gateway" half of the worklog MCP.
 *
 * The worklog tools run locally (they read your disk). The leaderboard tools
 * (docs / rankings / reviews) run on Nextdev's hosted MCP, where the scoring +
 * data live. This module mirrors the hosted tool list and forwards tool calls
 * to it — so one local install exposes BOTH, while the ranking logic stays
 * server-side (we only forward; nothing about the scoring ships here).
 *
 * Config (env):
 *   NEXTDEV_MCP_URL           hosted endpoint (default prod). Point it at a local
 *                             `next dev` (http://localhost:3000/api/mcp) to test.
 *   NEXTDEV_DISABLE_BENCHMARKS=1   worklog-only install — hide the leaderboard tools.
 *
 * Local-first by construction: if the backend is unreachable, the leaderboard
 * tools simply don't appear and the worklog tools keep working.
 */

const BACKEND_URL = process.env.NEXTDEV_MCP_URL || 'https://www.joinnextdev.com/api/mcp';
const DISABLED = ['1', 'true', 'yes', 'on'].includes((process.env.NEXTDEV_DISABLE_BENCHMARKS || '').toLowerCase());
const TIMEOUT_MS = Number(process.env.NEXTDEV_MCP_TIMEOUT_MS) || 8000;

export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: any;
}

let toolsCache: RemoteTool[] | null = null;
let instructionsCache: string | null = null;

async function rpc(method: string, params?: any): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
    const j: any = await res.json();
    if (j?.error) throw new Error(j.error.message || 'backend error');
    return j?.result;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the leaderboard (benchmark) tools should be exposed. */
export function benchmarksEnabled(): boolean {
  return !DISABLED;
}

/** Mirror the hosted tool list (cached). Empty if disabled or the backend is down. */
export async function remoteToolDefs(): Promise<RemoteTool[]> {
  if (DISABLED) return [];
  if (toolsCache) return toolsCache;
  try {
    const r = await rpc('tools/list');
    toolsCache = (r?.tools || []).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return toolsCache!;
  } catch {
    return []; // backend unreachable → leaderboard tools absent; worklog unaffected
  }
}

/** The hosted server's `instructions` (cached) so the gateway advertises both worlds. */
export async function remoteInstructions(): Promise<string> {
  if (DISABLED) return '';
  if (instructionsCache !== null) return instructionsCache;
  try {
    const r = await rpc('initialize');
    const text = typeof r?.instructions === 'string' ? r.instructions : '';
    instructionsCache = text;
    return text;
  } catch {
    instructionsCache = '';
    return '';
  }
}

/** Forward a tools/call to the hosted endpoint and return its result (the {content:[…]} shape). */
export async function callRemoteTool(name: string, args: Record<string, any>): Promise<any> {
  return rpc('tools/call', { name, arguments: args });
}
