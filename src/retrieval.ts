/**
 * retrieval.ts — hybrid BM25 + embedding retrieval over toolDocs entries.
 *
 * Flow per call:
 *   1. readToolDocsEntries(slug)         — one Firestore subcollection read
 *   2. embedQuery(query)                 — one OpenAI call (~$0.00001) if available
 *   3. score each entry in memory        — BM25 + cosine + hybrid combine
 *   4. sort, take top-K
 *
 * BM25 and cosine both run on ~500 entries in single-digit milliseconds.
 *
 * Graceful degradation: if OPENAI_API_KEY isn't set OR the cached entries
 * have no embeddings, retrieval falls back to BM25-only (still useful, just
 * less semantic). No crash.
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import OpenAI from 'openai';
import {
  readToolDocsEntries,
  TOOL_DOCS_EMBEDDING_MODEL,
  TOOL_DOCS_EMBEDDING_DIM,
  type ToolDocsEntry,
} from './toolDocs.js';

let openaiCached: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (openaiCached) return openaiCached;
  if (!process.env.OPENAI_API_KEY) return null;
  openaiCached = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiCached;
}

export interface RetrievalSeed {
  customerName: string;
  competitorOrPartnerName: string;
  useCase: string;
  postType: string;
  extraKeywords?: string[];
}

export interface ScoredEntry {
  entry: ToolDocsEntry;
  bm25: number;
  embedding: number; // 0 when no embedding present
  hybrid: number;
}

// ─── Query string ───────────────────────────────────────────────────────────

export function buildQueryString(seed: RetrievalSeed): string {
  const parts: string[] = [
    seed.customerName,
    seed.competitorOrPartnerName,
    seed.useCase,
    postTypeKeywords(seed.postType),
    ...(seed.extraKeywords || []),
  ].filter(Boolean);
  return parts.join(' ').trim();
}

function postTypeKeywords(postType: string): string {
  switch (postType) {
    case 'customer-api-comparison':
      return 'comparison alternatives integration api endpoints sdk';
    case 'partner-integration-tutorial':
      return 'integration tutorial setup connect webhook quickstart';
    case 'changelog-tutorial':
      return 'changelog release new feature update migration';
    case 'industry-use-case-tutorial':
      return 'use case industry tutorial how-to guide example';
    default:
      return '';
  }
}

// ─── Tokenization ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'will', 'with', 'about', 'into', 'than', 'then', 'they',
  'their', 'we', 'you', 'your', 'our',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ─── BM25 ───────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface BM25Index {
  docs: string[][];
  df: Map<string, number>;
  avgdl: number;
  N: number;
}

function buildBm25Index(entries: ToolDocsEntry[]): BM25Index {
  const docs = entries.map((e) => tokenize(`${e.title} ${e.description}`));
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.length;
    const uniq = new Set(doc);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docs, df, avgdl: docs.length > 0 ? totalLen / docs.length : 0, N: docs.length };
}

function bm25Score(query: string, index: BM25Index): number[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const scores = new Array(index.N).fill(0);
  for (const term of queryTokens) {
    const df = index.df.get(term) || 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < index.N; i++) {
      const doc = index.docs[i];
      if (doc.length === 0) continue;
      let tf = 0;
      for (const t of doc) if (t === term) tf++;
      if (tf === 0) continue;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (index.avgdl || 1)));
      scores[i] += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
  }
  return scores;
}

// ─── Embedding ──────────────────────────────────────────────────────────────

export async function embedQuery(query: string): Promise<number[] | null> {
  const client = getOpenAI();
  if (!client) return null;
  const res = await client.embeddings.create({
    model: TOOL_DOCS_EMBEDDING_MODEL,
    input: query,
    dimensions: TOOL_DOCS_EMBEDDING_DIM,
  });
  return res.data[0].embedding;
}

export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Hybrid retrieval ───────────────────────────────────────────────────────

function normalize(vals: number[]): number[] {
  const max = Math.max(...vals, 0);
  if (max === 0) return vals.map(() => 0);
  return vals.map((v) => v / max);
}

export interface RetrieveTopKOptions {
  k?: number; // default 40
  useEmbedding?: boolean; // default true
  wBm25?: number; // default 0.4
  wEmbed?: number; // default 0.6
}

export async function retrieveTopK(
  seed: RetrievalSeed,
  slug: string,
  opts: RetrieveTopKOptions = {},
  preloadedEntries?: ToolDocsEntry[],
): Promise<ScoredEntry[]> {
  const k = opts.k ?? 40;
  const useEmbedding = opts.useEmbedding ?? true;
  const wBm25 = opts.wBm25 ?? 0.4;
  const wEmbed = opts.wEmbed ?? 0.6;

  const entries = preloadedEntries ?? (await readToolDocsEntries(slug));
  if (entries.length === 0) return [];

  const query = buildQueryString(seed);
  const index = buildBm25Index(entries);
  const bm25Raw = bm25Score(query, index);
  const bm25Norm = normalize(bm25Raw);

  let embedNorm: number[] = new Array(entries.length).fill(0);
  if (useEmbedding) {
    const haveEmbeds = entries.every(
      (e) => Array.isArray(e.embedding) && e.embedding!.length > 0
    );
    if (haveEmbeds) {
      const qVec = await embedQuery(query);
      if (qVec) {
        const raw = entries.map((e) => cosine(qVec, e.embedding!));
        embedNorm = normalize(raw);
      }
      // else: OPENAI_API_KEY not set → BM25-only fallback, embedNorm stays 0
    }
  }

  const scored: ScoredEntry[] = entries.map((entry, i) => ({
    entry,
    bm25: bm25Raw[i],
    embedding: embedNorm[i] || 0,
    hybrid: wBm25 * bm25Norm[i] + wEmbed * embedNorm[i],
  }));
  scored.sort((a, b) => b.hybrid - a.hybrid);
  return scored.slice(0, k);
}
