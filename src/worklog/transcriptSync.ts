// Transcript capture — reads the verbatim Claude Code session transcript that
// the agent already writes to ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// and (a) renders a thin human-readable transcript.md into .nextdev/logs/ so the
// "look at my nextdev logs" workflow keeps working, and (b) hands the raw .jsonl
// to an injected upload function for backend ingest/analysis.
//
// This deliberately does NOT do the heavy normalization (turn model, tool_use↔
// tool_result linkage, outcome analysis). That lives on the backend, where it can
// be iterated without shipping a new extension. See the plan: the extension stays
// thin; the backend is the brains.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

/** A single parsed turn, just enough to render readable markdown. */
export interface RenderedTurn {
	promptId?: string;
	timestamp?: string;
	prompt: string;
	response: string;        // concatenated assistant text blocks
	trace: string[];         // one short line per tool the agent used
	files: string[];         // files the agent read/wrote/edited this turn (deduped)
}

/** A located session file, used for cross-session enumeration. */
export interface SessionRef {
	sessionFile: string;
	sessionId: string;
	projectDir: string;
	cwd: string | null;
}

export interface TranscriptLocation {
	sessionFile: string;     // absolute path to the .jsonl
	sessionId: string;       // uuid (filename without extension)
	projectDir: string;      // the ~/.claude/projects/<dir> directory
}

export interface SyncResult {
	location: TranscriptLocation;
	turnCount: number;
	transcriptMdPath: string;
	uploaded: boolean;
}

/** Injected uploader so this module has no dependency on the backend service. */
export type RawUploader = (args: {
	gzippedJsonl: Buffer;
	sessionId: string;
	projectPath: string;
	rawBytes: number;
}) => Promise<void>;

export interface SyncOptions {
	/** The active project / workspace root (the cwd the agent is running in). */
	projectPath: string;
	/** Optional uploader for the raw transcript; if omitted, only the local render runs. */
	upload?: RawUploader;
	/** Optional logger. */
	log?: (msg: string) => void;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function noop(_msg: string) { /* no-op */ }

/**
 * Claude Code encodes the cwd into the project dir name by replacing path
 * separators (and dots) with '-'. We try that first as a fast path, then fall
 * back to scanning every project dir and matching the in-entry `cwd` field —
 * robust against any encoding quirk.
 */
function encodeCwd(projectPath: string): string {
	return projectPath.replace(/[/\\.]/g, '-');
}

/** Read the first parseable entry that carries a `cwd` field. */
function readSessionCwd(sessionFile: string): string | null {
	let fd: number | null = null;
	try {
		// Read a bounded chunk from the head — enough to catch an entry with cwd
		// without loading a multi-MB file.
		const buf = Buffer.alloc(64 * 1024);
		fd = fs.openSync(sessionFile, 'r');
		const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
		const head = buf.toString('utf8', 0, bytes);
		for (const line of head.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const obj = JSON.parse(trimmed);
				if (obj && typeof obj.cwd === 'string') return obj.cwd;
			} catch {
				// partial trailing line in the bounded read — ignore
			}
		}
	} catch {
		// unreadable — ignore
	} finally {
		if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
	}
	return null;
}

/** List .jsonl session files in a project dir, newest first. */
function listSessions(projectDir: string): string[] {
	try {
		return fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f))
			.filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	} catch {
		return [];
	}
}

/**
 * Locate the newest Claude Code session transcript for the given project path.
 * Returns null if none found (e.g. the agent isn't Claude Code, or no session yet).
 */
export function locateSession(projectPath: string, log: (m: string) => void = noop): TranscriptLocation | null {
	if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
		log(`[transcriptSync] No ~/.claude/projects dir; nothing to capture.`);
		return null;
	}

	const candidates: string[] = [];

	// Fast path: the encoded dir name.
	const encodedDir = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(projectPath));
	if (fs.existsSync(encodedDir)) candidates.push(encodedDir);

	// Robust fallback: scan all project dirs and match the in-entry cwd.
	if (candidates.length === 0) {
		let dirs: string[] = [];
		try { dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR); } catch { dirs = []; }
		for (const d of dirs) {
			const dir = path.join(CLAUDE_PROJECTS_DIR, d);
			let isDir = false;
			try { isDir = fs.statSync(dir).isDirectory(); } catch { /* ignore */ }
			if (!isDir) continue;
			const sessions = listSessions(dir);
			if (sessions.length && readSessionCwd(sessions[0]) === projectPath) {
				candidates.push(dir);
			}
		}
	}

	for (const dir of candidates) {
		const sessions = listSessions(dir);
		for (const sessionFile of sessions) {
			// Confirm the matched session actually belongs to this project.
			const cwd = readSessionCwd(sessionFile);
			if (cwd === null || cwd === projectPath) {
				return {
					sessionFile,
					sessionId: path.basename(sessionFile, '.jsonl'),
					projectDir: dir,
				};
			}
		}
	}

	log(`[transcriptSync] No session transcript matched project path: ${projectPath}`);
	return null;
}

/**
 * Enumerate session files for a scope, newest first.
 * - 'project': sessions belonging to projectPath (encoded-dir fast path, then cwd-match fallback).
 * - 'global': every session under ~/.claude/projects.
 */
export function enumerateSessionFiles(projectPath: string, scope: 'project' | 'global' = 'project'): SessionRef[] {
	if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
	const refs: SessionRef[] = [];

	const collect = (dir: string) => {
		for (const sessionFile of listSessions(dir)) {
			const cwd = readSessionCwd(sessionFile);
			if (scope === 'project' && cwd !== null && cwd !== projectPath) continue;
			refs.push({ sessionFile, sessionId: path.basename(sessionFile, '.jsonl'), projectDir: dir, cwd });
		}
	};

	if (scope === 'project') {
		// Fast path: the encoded dir for this project.
		const encodedDir = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(projectPath));
		if (fs.existsSync(encodedDir)) collect(encodedDir);
		if (refs.length === 0) {
			// Fallback: scan all dirs, keep sessions whose in-entry cwd matches.
			let dirs: string[] = [];
			try { dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR); } catch { dirs = []; }
			for (const d of dirs) {
				const dir = path.join(CLAUDE_PROJECTS_DIR, d);
				try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
				if (dir === encodedDir) continue;
				collect(dir);
			}
		}
	} else {
		let dirs: string[] = [];
		try { dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR); } catch { dirs = []; }
		for (const d of dirs) {
			const dir = path.join(CLAUDE_PROJECTS_DIR, d);
			try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
			collect(dir);
		}
	}

	refs.sort((a, b) => {
		try { return fs.statSync(b.sessionFile).mtimeMs - fs.statSync(a.sessionFile).mtimeMs; } catch { return 0; }
	});
	return refs;
}

/** Extract plain text from a message.content that may be a string or block array. */
function extractText(content: unknown, blockType: 'text' | 'tool_use' | 'tool_result'): string[] {
	const out: string[] = [];
	if (typeof content === 'string') {
		if (blockType === 'text' && content.trim()) out.push(content.trim());
		return out;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			if ((block as any).type !== blockType) continue;
			if (blockType === 'text' && typeof (block as any).text === 'string') {
				out.push((block as any).text.trim());
			}
		}
	}
	return out;
}

/** Does this user-content carry a real typed prompt (vs only tool_result blocks)? */
function hasUserPromptText(content: unknown): string {
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		const texts = extractText(content, 'text');
		return texts.join('\n').trim();
	}
	return '';
}

// Our own logging plumbing is pure noise in a work-log trace — filter it out so
// the cut log shows what the agent actually did, not how it was being logged.
const NEXTDEV_LOG_TOOLS = /nextdev_(log_intent|log_outcome|toggle_logging)/i;

/** One short trace line per tool_use block. */
function traceLinesFromAssistant(content: unknown): string[] {
	const lines: string[] = [];
	if (!Array.isArray(content)) return lines;
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		if ((block as any).type !== 'tool_use') continue;
		const name = (block as any).name || 'tool';
		if (NEXTDEV_LOG_TOOLS.test(name)) continue;
		const input = (block as any).input || {};
		let detail = '';
		if (typeof input.file_path === 'string') detail = input.file_path;
		else if (typeof input.command === 'string') detail = String(input.command).slice(0, 80);
		else if (typeof input.path === 'string') detail = input.path;
		else if (typeof input.description === 'string') detail = String(input.description).slice(0, 80);
		lines.push(detail ? `${name}: ${detail}` : `${name}`);
	}
	return lines;
}

// Tools whose input names a file the agent touched.
const FILE_TOOLS = /(^|_|:|\.|\/)(read|write|edit|multiedit|notebookedit)$/i;

/** Files referenced by file-touching tool_use blocks this assistant message. */
function filesFromAssistant(content: unknown): string[] {
	const files: string[] = [];
	if (!Array.isArray(content)) return files;
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		if ((block as any).type !== 'tool_use') continue;
		const name = String((block as any).name || '');
		if (!FILE_TOOLS.test(name)) continue;
		const input = (block as any).input || {};
		const fp = typeof input.file_path === 'string' ? input.file_path
			: typeof input.path === 'string' ? input.path
			: typeof input.notebook_path === 'string' ? input.notebook_path
			: '';
		if (fp) files.push(fp);
	}
	return files;
}

const SKIP_TYPES = new Set([
	'mode', 'permission-mode', 'ai-title', 'bridge-session',
	'last-prompt', 'file-history-snapshot',
]);

/**
 * Parse a session .jsonl into renderable turns. A turn starts at a real user
 * prompt (type=user with promptId/text, not a sidechain, not meta) and absorbs
 * the assistant text + tool calls that follow until the next user prompt.
 */
export function parseTurns(sessionFile: string): RenderedTurn[] {
	const turns: RenderedTurn[] = [];
	let current: RenderedTurn | null = null;

	const raw = fs.readFileSync(sessionFile, 'utf8');
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: any;
		try { entry = JSON.parse(trimmed); } catch { continue; }
		const type = entry?.type;
		if (!type || SKIP_TYPES.has(type)) continue;
		if (entry.isSidechain === true) continue;     // subagent chatter — backend nests it; skip in thin render
		if (entry.isMeta === true) continue;
		const msg = entry.message;

		if (type === 'user') {
			const promptText = hasUserPromptText(msg?.content);
			// Only a real, typed prompt (has promptId + text) starts a new turn.
			if (entry.promptId && promptText) {
				if (current) turns.push(current);
				current = {
					promptId: entry.promptId,
					timestamp: entry.timestamp,
					prompt: promptText,
					response: '',
					trace: [],
					files: [],
				};
			}
			// user entries that are tool_result carriers are ignored in the thin render
			continue;
		}

		if (type === 'assistant' && current) {
			const texts = extractText(msg?.content, 'text');
			if (texts.length) {
				current.response = [current.response, ...texts].filter(Boolean).join('\n\n');
			}
			current.trace.push(...traceLinesFromAssistant(msg?.content));
			current.files.push(...filesFromAssistant(msg?.content));
		}
	}
	if (current) turns.push(current);
	for (const t of turns) t.files = Array.from(new Set(t.files));
	return turns;
}

function localDateStr(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function timeStr(iso?: string): string {
	const d = iso ? new Date(iso) : new Date();
	if (isNaN(d.getTime())) return '';
	return d.toTimeString().slice(0, 8);
}

/** Render turns to a thin, readable transcript.md. */
export function renderTranscriptMarkdown(turns: RenderedTurn[], sessionId: string): string {
	const header = `# Nextdev session transcript\n\nSession: \`${sessionId}\`\nTurns: ${turns.length}\n\n_Auto-generated from the Claude Code session transcript. The full structured trace and outcome analysis live in the backend._\n\n---\n`;
	const body = turns.map((t, i) => {
		const title = (t.prompt.split('\n').find(l => l.trim()) || `Turn ${i + 1}`).slice(0, 120);
		const time = timeStr(t.timestamp);
		const traceBlock = t.trace.length
			? t.trace.map(l => `- ${l}`).join('\n')
			: '_(no tool calls)_';
		return [
			`\n## ${time ? `[${time}] ` : ''}${title}`,
			``,
			`**Prompt:**`,
			'```',
			t.prompt,
			'```',
			``,
			`**Agent Response:**`,
			t.response ? t.response : '_(no text response)_',
			``,
			`**Trace:**`,
			traceBlock,
			``,
			`---`,
		].join('\n');
	}).join('\n');
	return header + body + '\n';
}

/** Write the rendered transcript into .nextdev/logs/<date>/<session>/transcript.md. */
export function writeLocalTranscript(projectPath: string, sessionId: string, markdown: string): string {
	const dir = path.join(projectPath, '.nextdev', 'logs', localDateStr(), sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const outPath = path.join(dir, 'transcript.md');
	fs.writeFileSync(outPath, markdown, 'utf8');
	return outPath;
}

/**
 * Top-level entry: locate the active session, render the local transcript.md, and
 * (if an uploader is provided) ship the raw gzipped .jsonl to the backend.
 * Returns null if there is nothing to capture (non-Claude-Code agent, no session).
 */
export async function syncTranscript(opts: SyncOptions): Promise<SyncResult | null> {
	const log = opts.log || noop;
	const location = locateSession(opts.projectPath, log);
	if (!location) return null;

	const turns = parseTurns(location.sessionFile);
	const md = renderTranscriptMarkdown(turns, location.sessionId);
	const transcriptMdPath = writeLocalTranscript(opts.projectPath, location.sessionId, md);
	log(`[transcriptSync] Wrote ${turns.length} turns → ${transcriptMdPath}`);

	let uploaded = false;
	if (opts.upload) {
		try {
			const rawBuf = fs.readFileSync(location.sessionFile);
			const gz = zlib.gzipSync(rawBuf);
			await opts.upload({
				gzippedJsonl: gz,
				sessionId: location.sessionId,
				projectPath: opts.projectPath,
				rawBytes: rawBuf.length,
			});
			uploaded = true;
			log(`[transcriptSync] Uploaded raw transcript (${rawBuf.length} bytes raw, ${gz.length} gzipped).`);
		} catch (err) {
			// Upload is best-effort; the local render is the guaranteed result.
			log(`[transcriptSync] Upload failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { location, turnCount: turns.length, transcriptMdPath, uploaded };
}
