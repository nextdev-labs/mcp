/**
 * Nextdev MCP HTTP server.
 *
 * Speaks MCP Streamable HTTP at /api/mcp (or wherever you mount it).
 * Stand-alone Node — no Next.js, no Express. Use this as a starting point
 * to drop into your own framework.
 *
 *   GET  /            → server info (so a browser/curl can confirm liveness)
 *   GET  /api/mcp     → server info (same)
 *   POST /api/mcp     → JSON-RPC dispatch (initialize, tools/list, tools/call)
 *
 * Set PORT to choose the listen port (defaults to 3000).
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dispatch, type JsonRpcResponse } from './server.js';

const SERVER_INFO_RESPONSE = {
  name: 'nextdev-mcp',
  version: '0.6.1',
  transport: 'http',
  protocol: 'mcp/2024-11-05',
  docs: 'POST JSON-RPC 2.0 messages here. Supported methods: initialize, tools/list, tools/call.',
  example: {
    request: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  },
  hostedEndpoint: 'https://www.joinnextdev.com/api/mcp',
  source: 'https://github.com/nextdev-labs/mcp',
};

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
};

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Protect against large payloads that could OOM the process.
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Simple in-memory rate limiter per IP. Sufficient for single-instance deployments.
const RATE_LIMIT_MAX = 50; // requests
const RATE_LIMIT_WINDOW_MS = 60_000; // per minute
const rateMap = new Map<
  string,
  { count: number; windowStart: number }
>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Discovery / liveness
  if (req.method === 'GET' && (path === '/' || path === '/api/mcp')) {
    writeJson(res, 200, SERVER_INFO_RESPONSE);
    return;
  }

  // JSON-RPC dispatch
  if (req.method === 'POST' && (path === '/' || path === '/api/mcp')) {
    // Rate limit per IP
    const ip = (typeof req.headers['x-forwarded-for'] === 'string' ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim() : undefined) || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateMap.get(ip);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateMap.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
      rateMap.set(ip, entry);
      if (entry.count > RATE_LIMIT_MAX) {
        writeJson(res, 429, {
          jsonrpc: '2.0',
          id: null,
          error: { code: 429, message: 'Too Many Requests' },
        });
        return;
      }
    }

    let body: any;
    try {
      const raw = await readBody(req, 5 * 1024 * 1024);
      body = JSON.parse(raw);
    } catch {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = await Promise.all(body.map((r) => dispatch(r)));
      writeJson(res, 200, responses);
      return;
    }

    const response = await dispatch(body);
    writeJson(res, 200, response);
    return;
  }

  writeJson(res, 404, { error: 'Not found. POST JSON-RPC to /api/mcp.' });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Nextdev MCP listening on http://localhost:${port}/api/mcp`);
  console.log(`Hosted equivalent: ${SERVER_INFO_RESPONSE.hostedEndpoint}`);
});
