#!/usr/bin/env node
/**
 * Worklog MCP — stdio transport entry (the `nextdev-worklog` bin).
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * This is the local server an MCP client (Claude Code, Cursor) spawns; it reads
 * the user's own Claude Code transcripts from disk and answers queries.
 *
 * stdout carries ONLY protocol messages. Notifications produce no response.
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import { createInterface } from 'node:readline';
import { dispatch } from './dispatch.js';

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: any;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON noise
  }
  // JSON-RPC notifications (notifications/*) take no response.
  const isNotification = typeof req?.method === 'string' && req.method.startsWith('notifications/');
  try {
    const res = await dispatch(req);
    if (!isNotification) process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e: any) {
    if (!isNotification) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: e?.message || 'Internal error' } }) + '\n',
      );
    }
  }
});

// Don't hard-exit on stdin close — let any in-flight request (e.g. a slow proxied
// leaderboard call) finish writing, then exit naturally when the loop drains.
rl.on('close', () => { process.exitCode = 0; });
