/**
 * toolDocs — read-only access to the cached doc index for a tool.
 *
 * The hosted Nextdev backend periodically crawls each customer's docs and
 * caches an index of every page (title + description + embedding) under:
 *
 *   toolDocs/{slug}                  — pointer record (parent)
 *   toolDocs/{slug}/entries/{hash}   — one entry per llms.txt row
 *
 * Embedding model: text-embedding-3-small with dimensions=256 (Matryoshka).
 *
 * This OSS module exposes only the read paths needed by search_docs. Write
 * and index-management helpers live in the hosted backend.
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import { db } from './firebase.js';

export const TOOL_DOCS_EMBEDDING_MODEL = 'text-embedding-3-small';
export const TOOL_DOCS_EMBEDDING_DIM = 256;

export interface ToolDocsEntry {
  url: string;
  title: string;
  description: string;
  embedding?: number[];
  embeddingHash?: string;
  embeddingModel?: string;
}

export function slugifyToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export async function readToolDocsEntries(slug: string): Promise<ToolDocsEntry[]> {
  const normalized = slugifyToolName(slug);
  const col = db().collection('toolDocs').doc(normalized).collection('entries');
  const snap = await col.get();
  const out: ToolDocsEntry[] = [];
  for (const d of snap.docs) {
    const data = d.data() as any;
    out.push({
      url: data.url,
      title: data.title || '',
      description: data.description || '',
      embedding: Array.isArray(data.embedding) ? data.embedding : undefined,
      embeddingHash: data.embeddingHash,
      embeddingModel: data.embeddingModel,
    });
  }
  return out;
}
