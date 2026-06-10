// Query engine — the "ask your work history" layer.
//
// Multi-source: it reads from a list of registered WorkSources and merges their
// turns (newest-first). Each source knows how to enumerate sessions and load the
// cut turns for one session. Today:
//   - claude-code  : Claude Code session transcripts (~/.claude/projects/*.jsonl)
//   - nextdev-logs : the legacy .nextdev/logs back-catalog (private build only)
// An OSS package registers ONLY claude-code (just don't import nextdevLogsSource).
//
// Pure Node, no vscode, no network. Deterministic — substring/file/date filters,
// no LLM, no embeddings, no cost.

import * as fs from 'fs';
import { enumerateSessionFiles, parseTurns, RenderedTurn } from './transcriptSync.js';

export type Scope = 'project' | 'global';

/** A located session from some source, with a lazy loader for its turns. */
export interface SourceRef {
	sourceId: string;
	sessionId: string;
	cwd: string | null;
	sortKey: number;            // for newest-first merge (usually file mtime ms)
	loadTurns(): RenderedTurn[];
}

/** A pluggable history source. */
export interface WorkSource {
	id: string;
	listRefs(projectPath: string, scope: Scope): SourceRef[];
}

// ---- Source #1: Claude Code JSONL (wraps the existing cutting engine) -------
const claudeCodeSource: WorkSource = {
	id: 'claude-code',
	listRefs(projectPath, scope) {
		return enumerateSessionFiles(projectPath, scope).map(r => ({
			sourceId: 'claude-code',
			sessionId: r.sessionId,
			cwd: r.cwd,
			sortKey: (() => { try { return fs.statSync(r.sessionFile).mtimeMs; } catch { return 0; } })(),
			loadTurns: () => parseTurns(r.sessionFile),
		}));
	},
};

// Registered sources. The OSS package reads Claude Code transcripts only.
// (Nextdev's private build adds extra WorkSources — e.g. legacy log adapters.)
const SOURCES: WorkSource[] = [claudeCodeSource];

function getRefs(projectPath: string, scope: Scope): SourceRef[] {
	const refs = SOURCES.flatMap(s => {
		try { return s.listRefs(projectPath, scope); } catch { return []; }
	});
	refs.sort((a, b) => b.sortKey - a.sortKey);
	return refs;
}

// ---- Output shapes --------------------------------------------------------

export interface SessionMeta {
	sessionId: string;
	sourceId: string;
	cwd: string | null;
	date: string;
	lastModified: string;
	title: string;
	turnCount: number;
	filesTouched: string[];
}

export interface TurnMatch {
	sessionId: string;
	sourceId: string;
	cwd: string | null;
	turnIndex: number;        // 1-based
	timestamp?: string;
	title: string;
	prompt: string;
	response: string;
	trace: string[];
	files: string[];
}

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_MATCH_LIMIT = 20;
const DEFAULT_SCAN_BUDGET = 80;   // max sessions parsed in a search

function dateOf(turns: RenderedTurn[], sortKey: number): string {
	const ts = turns[0]?.timestamp;
	const d = ts ? new Date(ts) : new Date(sortKey || Date.now());
	return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function firstLine(s: string, max = 100): string {
	const line = (s.split('\n').find(l => l.trim()) || '').trim();
	return line.length > max ? line.slice(0, max) + '…' : line;
}

function metaFromRef(ref: SourceRef): SessionMeta | null {
	let turns: RenderedTurn[];
	try { turns = ref.loadTurns(); } catch { return null; }
	if (!turns.length) return null;
	const files = Array.from(new Set(turns.flatMap(t => t.files)));
	return {
		sessionId: ref.sessionId,
		sourceId: ref.sourceId,
		cwd: ref.cwd,
		date: dateOf(turns, ref.sortKey),
		lastModified: new Date(ref.sortKey || Date.now()).toISOString(),
		title: firstLine(turns[0].prompt),
		turnCount: turns.length,
		filesTouched: files,
	};
}

// ---- Data functions -------------------------------------------------------

export function listSessions(opts: { projectPath: string; scope?: Scope; limit?: number }): SessionMeta[] {
	const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
	const refs = getRefs(opts.projectPath, opts.scope ?? 'project').slice(0, limit);
	const out: SessionMeta[] = [];
	for (const ref of refs) {
		const m = metaFromRef(ref);
		if (m) out.push(m);
	}
	return out;
}

export function getSession(opts: {
	projectPath: string;
	sessionId: string;
	scope?: Scope;
	fromTurn?: number;
	toTurn?: number;
}): { meta: SessionMeta; turns: RenderedTurn[] } | null {
	const match = (scope: Scope) => getRefs(opts.projectPath, scope)
		.find(r => r.sessionId === opts.sessionId || r.sessionId.startsWith(opts.sessionId));
	const ref = match(opts.scope ?? 'project') || (opts.scope === 'global' ? undefined : match('global'));
	if (!ref) return null;
	const meta = metaFromRef(ref);
	if (!meta) return null;
	let turns = ref.loadTurns();
	const from = Math.max(1, opts.fromTurn ?? 1);
	const to = Math.min(turns.length, opts.toTurn ?? turns.length);
	turns = turns.slice(from - 1, to);
	return { meta, turns };
}

function turnMatch(ref: SourceRef, t: RenderedTurn, i: number): TurnMatch {
	return {
		sessionId: ref.sessionId,
		sourceId: ref.sourceId,
		cwd: ref.cwd,
		turnIndex: i + 1,
		timestamp: t.timestamp,
		title: firstLine(t.prompt),
		prompt: t.prompt,
		response: t.response,
		trace: t.trace,
		files: t.files,
	};
}

export function queryWork(opts: {
	projectPath: string;
	query?: string;
	file?: string;
	since?: string;
	until?: string;
	scope?: Scope;
	limit?: number;
}): TurnMatch[] {
	const limit = opts.limit ?? DEFAULT_MATCH_LIMIT;
	const q = opts.query?.toLowerCase().trim();
	const fileQ = opts.file?.toLowerCase().trim();
	const since = opts.since ? new Date(opts.since).getTime() : null;
	const until = opts.until ? new Date(opts.until).getTime() : null;

	const refs = getRefs(opts.projectPath, opts.scope ?? 'project').slice(0, DEFAULT_SCAN_BUDGET);
	const matches: TurnMatch[] = [];

	for (const ref of refs) {
		let turns: RenderedTurn[];
		try { turns = ref.loadTurns(); } catch { continue; }
		for (let i = 0; i < turns.length; i++) {
			const t = turns[i];
			if (since !== null || until !== null) {
				const ts = t.timestamp ? new Date(t.timestamp).getTime() : NaN;
				if (isNaN(ts)) continue;                 // a date filter is set but this turn has no timestamp
				if (since !== null && ts < since) continue;
				if (until !== null && ts > until) continue;
			}
			if (fileQ && !t.files.some(f => f.toLowerCase().includes(fileQ))) continue;
			if (q) {
				const hay = [t.prompt, t.response, t.trace.join('\n'), t.files.join('\n')].join('\n').toLowerCase();
				if (!hay.includes(q)) continue;
			}
			matches.push(turnMatch(ref, t, i));
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}

export function recentWork(opts: { projectPath: string; scope?: Scope; limit?: number }): TurnMatch[] {
	const limit = opts.limit ?? 10;
	const refs = getRefs(opts.projectPath, opts.scope ?? 'project').slice(0, DEFAULT_SCAN_BUDGET);
	const matches: TurnMatch[] = [];
	for (const ref of refs) {
		let turns: RenderedTurn[];
		try { turns = ref.loadTurns(); } catch { continue; }
		for (let i = turns.length - 1; i >= 0; i--) {
			matches.push(turnMatch(ref, turns[i], i));
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}

// ---- Markdown formatters (token-efficient) --------------------------------

function shortId(id: string): string {
	return id.startsWith('nextdev-') ? id : id.slice(0, 8);
}
function sourceTag(sourceId: string): string {
	return sourceId === 'nextdev-logs' ? 'nextdev' : 'cc';
}
function relFiles(files: string[], max = 4): string {
	if (!files.length) return '';
	const shown = files.slice(0, max).map(f => f.split('/').pop() || f);
	const extra = files.length > max ? ` +${files.length - max}` : '';
	return shown.join(', ') + extra;
}

export function formatSessionList(metas: SessionMeta[], scope: Scope): string {
	if (!metas.length) return `No sessions found (scope: ${scope}).`;
	const lines = metas.map(m =>
		`- \`${shortId(m.sessionId)}\` [${sourceTag(m.sourceId)}] · ${m.date} · ${m.turnCount} turn${m.turnCount === 1 ? '' : 's'} · ${m.title}` +
		(m.filesTouched.length ? `\n    files: ${relFiles(m.filesTouched)}` : ''));
	return `**Sessions (${metas.length}, scope: ${scope}):**\n${lines.join('\n')}`;
}

export function formatMatches(matches: TurnMatch[], heading: string): string {
	if (!matches.length) return `No matching turns found.`;
	const blocks = matches.map(mt => {
		const resp = firstLine(mt.response, 240);
		const trace = mt.trace.slice(0, 8).map(l => `  - ${l}`).join('\n');
		const more = mt.trace.length > 8 ? `\n  - …(+${mt.trace.length - 8} more)` : '';
		return [
			`### \`${shortId(mt.sessionId)}\` [${sourceTag(mt.sourceId)}] · turn ${mt.turnIndex}${mt.timestamp ? ` · ${mt.timestamp.slice(0, 16).replace('T', ' ')}` : ''}`,
			`**Prompt:** ${firstLine(mt.prompt, 200)}`,
			resp ? `**Did:** ${resp}` : '',
			mt.trace.length ? `**Trace:**\n${trace}${more}` : '',
			mt.files.length ? `**Files:** ${relFiles(mt.files, 8)}` : '',
		].filter(Boolean).join('\n');
	});
	return `**${heading} (${matches.length}):**\n\n${blocks.join('\n\n')}`;
}

export function formatSession(meta: SessionMeta, turns: RenderedTurn[], verbosity: 'summary' | 'full'): string {
	const header = `**Session \`${shortId(meta.sessionId)}\`** [${sourceTag(meta.sourceId)}] · ${meta.date} · ${meta.turnCount} turns` +
		(meta.cwd ? `\nProject: ${meta.cwd}` : '') +
		(meta.filesTouched.length ? `\nFiles touched: ${relFiles(meta.filesTouched, 12)}` : '');
	if (verbosity === 'summary') {
		const lines = turns.map((t, i) => `${i + 1}. ${firstLine(t.prompt, 110)}${t.files.length ? `  (${relFiles(t.files, 3)})` : ''}`);
		return `${header}\n\n${lines.join('\n')}`;
	}
	const blocks = turns.map((t, i) => [
		`## Turn ${i + 1}${t.timestamp ? ` · ${t.timestamp.slice(0, 16).replace('T', ' ')}` : ''}`,
		`**Prompt:**\n${t.prompt}`,
		`**Did:**\n${t.response || '_(no text response)_'}`,
		t.trace.length ? `**Trace:**\n${t.trace.map(l => `- ${l}`).join('\n')}` : '',
	].filter(Boolean).join('\n\n'));
	return `${header}\n\n${blocks.join('\n\n---\n\n')}`;
}
