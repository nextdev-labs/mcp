/**
 * Worklog MCP server — JSON-RPC dispatcher + tool registry (stdio transport).
 *
 * "Query your own work history." Reads the session transcripts that Claude Code
 * already writes to ~/.claude/projects/<cwd>/<uuid>.jsonl, cuts the noise, and
 * answers questions about your past work — without re-reading multi-MB JSONL.
 *
 * Local-only, read-only, no network, no auth. Zero third-party deps — same
 * minimal JSON-RPC shape as the hosted Nextdev MCP (src/server.ts).
 *
 * Tools:
 *   - list_sessions  → index of recent sessions (date, turns, title, files)
 *   - get_session    → the cut log of one session (summary | full, turn range)
 *   - query_work     → search turns by keyword / file touched / date range
 *   - recent_work    → newest turns across recent sessions
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import {
  listSessions,
  getSession,
  queryWork,
  recentWork,
  formatSessionList,
  formatMatches,
  formatSession,
  type Scope,
} from './queryEngine.js';
import { benchmarksEnabled, remoteToolDefs, remoteInstructions, callRemoteTool } from './remote.js';
import { maybeSweepArchive } from './archive.js';

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: any;
}
interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: any;
}
interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: any };
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function ok(id: string | number | null, result: any): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}
function err(id: string | number | null, code: number, message: string, data?: any): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: Record<string, any>) => Promise<string>;
}

const SERVER_INFO = {
  name: 'nextdev-worklog',
  version: '0.1.0',
  description:
    "Query your own AI work history. Reads Claude Code's local session transcripts and returns clean, token-efficient slices — what you worked on, what the agent did, and which files changed — so an agent can recall past work instead of grepping raw JSONL.",
};

// Injected as the top-level `instructions` field of the initialize response —
// Claude Code / Cursor put this into the model's system prompt on connect, so
// the agent reaches for these tools instead of re-asking the user.
const SERVER_INSTRUCTIONS = [
  'You can also recall the user\'s OWN past work locally (instant, private — reads transcripts already on disk).',
  'Before asking the user to re-explain something they already did, call `recent_work` (where you left off) or `query_work` to recall it yourself.',
  '`query_work({ query, file, since, until })` is fuzzy + ranked — describe the concept in plain words, and map any time reference ("March", "last week") to `since`/`until`.',
  'Use `list_sessions` to orient, then `get_session` to open one session in detail. All local, read-only.',
].join(' ');

const projectCwd = () => process.cwd();

const tools: ToolDef[] = [
  {
    name: 'list_sessions',
    description:
      'List recent work sessions for this project (or globally): date, turn count, title, and files touched. Cheaper than reading raw transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'global'], description: "'project' (this repo, default) or 'global' (all your projects)." },
        limit: { type: 'number', description: 'Max sessions to return (default 25, newest first).' },
      },
    },
    handler: async (args) => {
      const scope = (args.scope as Scope) || 'project';
      const metas = listSessions({ projectPath: projectCwd(), scope, limit: args.limit });
      return formatSessionList(metas, scope);
    },
  },
  {
    name: 'get_session',
    description:
      "Get the cut log of one past session (prompt + what the agent did + tool trace per turn). Use verbosity='summary' for an overview, or a turn range to control size.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id (or short prefix) from list_sessions.' },
        verbosity: { type: 'string', enum: ['summary', 'full'], description: "'summary' (default) or 'full'." },
        from_turn: { type: 'number', description: '1-based first turn to include.' },
        to_turn: { type: 'number', description: '1-based last turn to include.' },
        scope: { type: 'string', enum: ['project', 'global'] },
      },
      required: ['session_id'],
    },
    handler: async (args) => {
      const res = getSession({
        projectPath: projectCwd(),
        sessionId: String(args.session_id),
        scope: args.scope as Scope | undefined,
        fromTurn: args.from_turn,
        toTurn: args.to_turn,
      });
      if (!res) return `No session found matching id: ${args.session_id}`;
      return formatSession(res.meta, res.turns, (args.verbosity as 'summary' | 'full') || 'summary');
    },
  },
  {
    name: 'query_work',
    description:
      "Search your past work history. `query` is FUZZY and RANKED — describe the concept in plain words and it returns the most relevant turns first (it matches turns containing ANY of your words, scored by overlap), so vague phrasing works. Narrow with `file` (a path fragment) and/or a date window: when the user mentions a time — 'March', 'last week', 'around April' — translate it into `since`/`until` to scope the search to that period. Use this BEFORE asking the user to re-explain prior work.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in plain words (fuzzy + ranked — no need for an exact phrase).' },
        file: { type: 'string', description: 'Match turns that read/wrote/edited a file whose path contains this.' },
        since: { type: 'string', description: "ISO date (YYYY-MM-DD). Set from the user's time reference — e.g. 'March' → since 2026-03-01." },
        until: { type: 'string', description: "ISO date (YYYY-MM-DD). Set from the user's time reference — e.g. 'March' → until 2026-03-31." },
        scope: { type: 'string', enum: ['project', 'global'] },
        limit: { type: 'number', description: 'Max matching turns (default 20).' },
      },
    },
    handler: async (args) => {
      const matches = queryWork({
        projectPath: projectCwd(),
        query: args.query,
        file: args.file,
        since: args.since,
        until: args.until,
        scope: args.scope as Scope | undefined,
        limit: args.limit,
      });
      const label =
        [args.query && `"${args.query}"`, args.file && `file:${args.file}`, args.since && `since ${args.since}`, args.until && `until ${args.until}`]
          .filter(Boolean)
          .join(' ') || 'all recent';
      return formatMatches(matches, `Matches for ${label}`);
    },
  },
  {
    name: 'recent_work',
    description: 'Show what you did most recently across your latest sessions (newest turns first). Use to recall where you left off.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max turns to return (default 10).' },
        scope: { type: 'string', enum: ['project', 'global'] },
      },
    },
    handler: async (args) => {
      const matches = recentWork({ projectPath: projectCwd(), scope: args.scope as Scope | undefined, limit: args.limit });
      return formatMatches(matches, 'Recent work');
    },
  },
];

export async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize': {
        // Snapshot live transcripts into the durable local archive (debounced,
        // non-blocking) so history survives Claude Code's ~30-day purge.
        void maybeSweepArchive();
        // Advertise both worlds: worklog instructions + (if enabled) the hosted
        // leaderboard server's instructions.
        const extra = await remoteInstructions();
        return ok(id, {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          instructions: extra ? `${extra}\n\n${SERVER_INSTRUCTIONS}` : SERVER_INSTRUCTIONS,
        });
      }

      case 'tools/list': {
        const local = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        const remote = await remoteToolDefs(); // [] if disabled or backend unreachable
        return ok(id, { tools: [...local, ...remote] });
      }

      case 'tools/call': {
        const { name, arguments: args = {} } = req.params || {};
        const local = tools.find((t) => t.name === name);
        if (local) {
          const text = await local.handler(args);
          return ok(id, { content: [{ type: 'text', text }] });
        }
        // Not a local worklog tool → forward to the hosted leaderboard MCP (moat stays server-side).
        if (benchmarksEnabled()) {
          const remote = await remoteToolDefs();
          if (remote.some((t) => t.name === name)) {
            return ok(id, await callRemoteTool(name, args));
          }
        }
        return err(id, -32601, `Unknown tool: ${name}`);
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return ok(id, {});

      default:
        return err(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e: any) {
    return err(id, -32603, e?.message || 'Internal error', { stack: e?.stack });
  }
}
