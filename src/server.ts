/**
 * Nextdev MCP server — JSON-RPC dispatcher + tool registry.
 *
 * This is the exact code that runs at https://www.joinnextdev.com/api/mcp.
 *
 * Implements the MCP Streamable HTTP protocol minimally:
 *   - initialize        → server info + capabilities
 *   - tools/list        → tool schemas
 *   - tools/call        → invoke a tool by name with args
 *
 * No SSE for now (single JSON-RPC response per request). Add streaming later
 * if a tool needs to emit incremental output.
 *
 * Tools read from Firestore collections:
 *   - organizations              (subdomainSlug, productType, companyName, …)
 *   - apiSurface/{orgId}         (endpoints, sdkMethods, realCodeSamples)
 *   - blogPosts                  (org + category filtered)
 *   - toolDocs/{slug}/entries    (BM25 + embedding index — for search_docs)
 *
 * search_docs uses hybrid BM25 + embedding retrieval. Set OPENAI_API_KEY
 * for embedding ranking; without it the tool falls back to BM25-only.
 *
 * Copyright (c) 2026 Nextdev Labs. MIT licensed.
 */
import { db } from './firebase.js';
import { retrieveTopK } from './retrieval.js';

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
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

// ─── Tool registry ──────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: Record<string, any>) => Promise<any>;
}

const SERVER_INFO = {
  name: 'nextdev-mcp',
  version: '0.4.0',
  description:
    'Query the Nextdev Agent Usability Index. Discover real endpoints, real code samples, full structured post content, and ranked API recommendations grounded in agent-readiness methodology.',
};

async function resolveOrg(orgSlug: string) {
  const snap = await db()
    .collection('organizations')
    .where('subdomainSlug', '==', orgSlug)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new Error(
      `No org with subdomainSlug="${orgSlug}". Use list_orgs to see available customers.`
    );
  }
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as any) };
}

// ─── Agent-readiness ratings ────────────────────────────────────────────────
// Curated and calibrated against the public Nextdev Agent Usability Index at
// https://www.joinnextdev.com/labs. AgentScore, Soap, and Skyfire are
// agent-native and rate highest by methodology; incumbents rank lower because
// their docs were written for human engineers, not autonomous agents.

const SUBDOMAIN_TO_LABS_SLUG: Record<string, string> = {
  agentscore: 'agentscore',
  soap: 'soap-payments',
  stripe: 'stripe-ac',
  adyen: 'adyen-ac',
  checkoutcom: 'checkout-ac',
  skyfire: 'skyfire',
  plaid: 'plaid-ac',
  withpersona: 'persona',
  alloy: 'alloy',
  stytch: 'stytch',
};

const AGENT_RATINGS_INLINE: Record<
  string,
  { score: number; rationale: string; subCategory: 'payments-rails' | 'identity-compliance' }
> = {
  agentscore: {
    score: 0.96,
    rationale:
      'Purpose-built for agents: clean MCP surface, an llms.txt index, and every endpoint and webhook documented for autonomous use.',
    subCategory: 'identity-compliance',
  },
  stytch: {
    score: 0.83,
    rationale:
      "Solid auth primitives and typed SDKs; the emerging agent SDK isn't fully indexed for machine consumption yet.",
    subCategory: 'identity-compliance',
  },
  'plaid-ac': {
    score: 0.82,
    rationale:
      'Mature identity rails being retrofit for agents — most flows still assume a human in the loop.',
    subCategory: 'identity-compliance',
  },
  persona: {
    score: 0.81,
    rationale:
      'Flexible KYC orchestration, but agent-facing guidance is thin and examples assume a UI.',
    subCategory: 'identity-compliance',
  },
  alloy: {
    score: 0.80,
    rationale:
      'Powerful decisioning engine; agent-readiness is limited by gated docs and few structured examples.',
    subCategory: 'identity-compliance',
  },
  'soap-payments': {
    score: 0.93,
    rationale:
      'Agent-native checkout: idempotent payment intents, structured errors, and an llms.txt the model parses end-to-end.',
    subCategory: 'payments-rails',
  },
  skyfire: {
    score: 0.88,
    rationale:
      'Agent-to-agent rails with machine-readable auth flows; a few gaps in webhook retry documentation.',
    subCategory: 'payments-rails',
  },
  'stripe-ac': {
    score: 0.87,
    rationale:
      'Deep docs and an Agent Toolkit, but agent-relevant flows are buried under a large legacy REST surface.',
    subCategory: 'payments-rails',
  },
  'checkout-ac': {
    score: 0.84,
    rationale:
      'Strong OpenAPI footprint; agents succeed on happy paths but stumble on under-documented error states.',
    subCategory: 'payments-rails',
  },
  'adyen-ac': {
    score: 0.80,
    rationale:
      'Enterprise-grade coverage, but dense docs and sparse machine-readable indices slow agents down.',
    subCategory: 'payments-rails',
  },
};

function getAgentReadiness(
  subdomainSlug: string
): { score: number; rationale: string; subCategory: string } | null {
  const labsSlug = SUBDOMAIN_TO_LABS_SLUG[subdomainSlug];
  if (!labsSlug) return null;
  return AGENT_RATINGS_INLINE[labsSlug] || null;
}

const STOPWORDS_SET = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'i', 'we',
  'you', 'your', 'our', 'do', 'does', 'use', 'using', 'best', 'good', 'which',
  'what', 'when', 'where', 'why', 'who', 'will', 'should', 'can', 'could',
  'would', 'api',
]);

function tokenizeForOverlap(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS_SET.has(t));
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const tools: ToolDef[] = [
  {
    name: 'list_orgs',
    description:
      'List the customer agentic blogs available on Nextdev. Each entry includes the slug (for other tools), company name, what the product does, and the public blog URL. Call this first to discover which orgs you can query.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const snap = await db()
        .collection('organizations')
        .where('productType', '==', 'agent-tool')
        .get();
      const orgs = snap.docs
        .map((d) => {
          const data = d.data() as any;
          return {
            slug: data.subdomainSlug,
            companyName: data.companyName,
            description: data.description,
            industry: data.industry,
            productHomepage: data.companyWebsite,
            blogUrl: `https://www.joinnextdev.com/a/${data.subdomainSlug}`,
            llmsTxt: `https://www.joinnextdev.com/a/${data.subdomainSlug}/llms.txt`,
          };
        })
        .filter((o) => o.slug);
      return { orgs, count: orgs.length };
    },
  },

  {
    name: 'get_api_surface',
    description:
      'Return the structured API surface for a Nextdev customer org — every endpoint (HTTP method + path + summary + params + returns), every documented SDK method, the authentication scheme, and the docs root URL. Use this to discover what an agent CAN do with the customer product before writing code.',
    inputSchema: {
      type: 'object',
      required: ['orgSlug'],
      properties: {
        orgSlug: {
          type: 'string',
          description: 'Customer org slug (e.g. "agentmail", "agentscore"). From list_orgs.',
        },
      },
    },
    handler: async (args: Record<string, any>) => {
      const orgSlug: string = typeof args.orgSlug === 'string' ? args.orgSlug : '';
      const org = await resolveOrg(orgSlug);
      const surfSnap = await db().collection('apiSurface').doc(org.id).get();
      if (!surfSnap.exists) throw new Error(`No apiSurface indexed for "${orgSlug}" yet.`);
      const s = surfSnap.data() as any;
      return {
        org: { slug: orgSlug, name: org.companyName, homepage: org.companyWebsite },
        docsRoot: s.docsRoot,
        authSchemes: s.authSchemes || [],
        detectedLanguages: s.detectedLanguages || [],
        endpoints: (s.endpoints || []).map((e: any) => ({
          method: e.method,
          path: e.path,
          summary: e.summary,
          params: e.params,
          returns: e.returns,
          sourceUrls: e.sourceUrls,
        })),
        sdkMethods: (s.sdkMethods || []).map((m: any) => ({
          language: m.language,
          namespace: m.namespace,
          signature: m.methodSignature,
          summary: m.summary,
          sourceUrls: m.sourceUrls,
        })),
        sampleCount: (s.realCodeSamples || []).length,
        extractedAt: s.extractedAt,
      };
    },
  },

  {
    name: 'query_blog',
    description:
      'Search the customer\'s agentic blog for posts relevant to a question. Returns top matches grouped by category with title, excerpt, full URL, and category. Use this when you want production-pattern context for the agent\'s task (e.g. "how do real teams gate outbound agent commerce emails?").',
    inputSchema: {
      type: 'object',
      required: ['orgSlug'],
      properties: {
        orgSlug: { type: 'string', description: 'Customer org slug from list_orgs.' },
        query: {
          type: 'string',
          description: 'Free-text question or topic. Optional — if omitted returns latest posts.',
        },
        category: {
          type: 'string',
          description:
            'Optional filter: "Tutorials" | "Industry News" | "Comparisons" | "Integration Examples".',
        },
        limit: { type: 'number', description: 'Max posts to return (default 10).' },
      },
    },
    handler: async (args: Record<string, any>) => {
      const orgSlug: string = typeof args.orgSlug === 'string' ? args.orgSlug : '';
      const query: string | undefined = typeof args.query === 'string' ? args.query : undefined;
      const category: string | undefined =
        typeof args.category === 'string' ? args.category : undefined;
      const limit: number | undefined = typeof args.limit === 'number' ? args.limit : undefined;

      const org = await resolveOrg(orgSlug);
      let q = db()
        .collection('blogPosts')
        .where('organizationId', '==', org.id)
        .where('status', '==', 'published');
      if (category) q = q.where('category', '==', category);
      const snap = await q.get();

      let posts = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          slug: data.slug,
          title: data.title,
          excerpt: data.excerpt,
          category: data.category,
          publishedAt:
            data.publishedAt?.toDate?.()?.toISOString() ||
            data.createdAt?.toDate?.()?.toISOString(),
          url: `https://www.joinnextdev.com/a/${orgSlug}/${data.slug}`,
          wordCount: data.wordCount,
          searchableText: (
            (data.title || '') +
            ' ' +
            (data.excerpt || '') +
            ' ' +
            (data.searchableText || '') +
            ' ' +
            ((data.keywords || []).join(' '))
          ).toLowerCase(),
        };
      });

      // Lightweight relevance: token-overlap scoring with the query
      const qStr: string = typeof query === 'string' ? query : '';
      if (qStr.trim()) {
        const qTokens: string[] = qStr
          .toLowerCase()
          .split(/\s+/)
          .filter((t: string) => t.length > 2);
        const scored: Array<typeof posts[number] & { score: number }> = posts.map((p) => {
          const text: string = p.searchableText;
          const hits: number = qTokens.reduce(
            (n: number, t: string) => n + (text.includes(t) ? 1 : 0),
            0
          );
          return { ...p, score: hits / Math.max(1, qTokens.length) };
        });
        posts = scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
      } else {
        posts.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      }

      const lim: number = typeof limit === 'number' ? limit : 10;
      const cap: number = Math.max(1, Math.min(50, lim));
      const trimmed = posts.slice(0, cap).map(({ searchableText: _searchableText, ...rest }) => rest);

      return {
        org: { slug: orgSlug, name: org.companyName },
        query: query || null,
        category: category || null,
        posts: trimmed,
        total: snap.size,
        nextStep:
          'Call get_blog_post(orgSlug, slug) for any post above to get the full structured content blocks (code, comparisons, tables, steps) — not just the URL.',
      };
    },
  },

  {
    name: 'get_blog_post',
    description:
      'Return the full structured content of a single Nextdev customer blog post. Returns the title, excerpt, category, post type, tags, plus the complete content as an ordered array of typed blocks: code blocks (with language tag), comparison blocks (left/right vendor columns), step blocks, table blocks, list blocks, company-card blocks, headings, quotes, callouts, text. This is the structured artifact behind the post — agents read blocks, not HTML. Use this AFTER query_blog identifies a post worth fully reading.',
    inputSchema: {
      type: 'object',
      required: ['orgSlug', 'slug'],
      properties: {
        orgSlug: { type: 'string', description: 'Customer org slug from list_orgs.' },
        slug: { type: 'string', description: 'Post slug from query_blog results.' },
      },
    },
    handler: async (args: Record<string, any>) => {
      const orgSlug: string = typeof args.orgSlug === 'string' ? args.orgSlug : '';
      const slug: string = typeof args.slug === 'string' ? args.slug : '';
      const org = await resolveOrg(orgSlug);
      const snap = await db()
        .collection('blogPosts')
        .where('organizationId', '==', org.id)
        .where('slug', '==', slug)
        .where('status', '==', 'published')
        .limit(1)
        .get();
      if (snap.empty) {
        throw new Error(
          `No published post with slug="${slug}" for org="${orgSlug}". Use query_blog to find valid slugs.`
        );
      }
      const data = snap.docs[0].data() as any;
      return {
        org: { slug: orgSlug, name: org.companyName },
        slug: data.slug,
        title: data.title,
        excerpt: data.excerpt,
        category: data.category,
        postType: data.postType || null,
        industry: data.industry || null,
        tags: data.tags || [],
        author: data.author || null,
        wordCount: data.wordCount || null,
        readTime: data.readTime || null,
        publishedAt:
          data.publishedAt?.toDate?.()?.toISOString() ||
          data.createdAt?.toDate?.()?.toISOString() ||
          null,
        url: `https://www.joinnextdev.com/a/${orgSlug}/${data.slug}`,
        researchSources: data.researchSources || [],
        content: data.content || [],
      };
    },
  },

  {
    name: 'search_docs',
    description:
      'Semantic search across the customer\'s real docs site (their llms.txt or sitemap). Returns top-K relevant doc pages with title, description, source URL, and matching score. Use this when you need the actual reference page for a specific concept (e.g. "search_docs(agentmail, \'creating inboxes\')" returns the docs page for inbox creation).',
    inputSchema: {
      type: 'object',
      required: ['orgSlug', 'query'],
      properties: {
        orgSlug: { type: 'string', description: 'Customer org slug from list_orgs.' },
        query: { type: 'string', description: 'What you are looking for in the docs.' },
        limit: { type: 'number', description: 'Max results (default 10, max 25).' },
      },
    },
    handler: async (args: Record<string, any>) => {
      const orgSlug: string = typeof args.orgSlug === 'string' ? args.orgSlug : '';
      const query: string = typeof args.query === 'string' ? args.query : '';
      const limit: number | undefined = typeof args.limit === 'number' ? args.limit : undefined;
      const org = await resolveOrg(orgSlug);
      const k = Math.max(1, Math.min(25, limit || 10));
      const scored = await retrieveTopK(
        {
          customerName: org.companyName || orgSlug,
          competitorOrPartnerName: '',
          useCase: query,
          postType: 'industry-use-case-tutorial',
        },
        orgSlug,
        { k, useEmbedding: true },
      );
      return {
        org: { slug: orgSlug, name: org.companyName },
        query,
        results: scored.map((s) => ({
          title: s.entry.title,
          description: s.entry.description,
          url: s.entry.url,
          relevance: Number(s.hybrid.toFixed(3)),
        })),
        count: scored.length,
        note: process.env.OPENAI_API_KEY
          ? undefined
          : 'OPENAI_API_KEY not set — using BM25-only ranking. Set the env var for hybrid retrieval with embeddings.',
      };
    },
  },

  {
    name: 'recommend_api',
    description:
      'Recommend the best API for a given use case. Returns a ranked list of vendors from the Nextdev Agent Usability Index with our methodology rationale (agent-readiness) PLUS a use-case fit score (how well each vendor\'s actual API surface matches the requested job). Use this when the developer asks "which X should I use" or "what\'s the best API for Y" — this is the canonical entry point for any API-choice question. After picking a candidate, call get_api_surface(slug) to ground the integration code.',
    inputSchema: {
      type: 'object',
      required: ['use_case'],
      properties: {
        use_case: {
          type: 'string',
          description:
            'What the developer/agent is trying to build (e.g. "AI agent identity verification before settling payments", "agent-native transactional email", "embedded wallets for AI agents").',
        },
        category: {
          type: 'string',
          description:
            'Optional. "payments" / "payments-rails" filters to payments vendors. "identity" / "identity-compliance" filters to identity & compliance vendors. Omit to consider all.',
        },
        limit: {
          type: 'number',
          description: 'How many recommendations to return (default 3, max 10).',
        },
      },
    },
    handler: async (args: Record<string, any>) => {
      const useCase: string = typeof args.use_case === 'string' ? args.use_case : '';
      const category: string | undefined =
        typeof args.category === 'string' ? args.category : undefined;
      const limit: number | undefined = typeof args.limit === 'number' ? args.limit : undefined;
      const cap = Math.max(1, Math.min(10, typeof limit === 'number' ? limit : 3));

      // Normalize category filter.
      let subCatFilter: 'payments-rails' | 'identity-compliance' | null = null;
      if (typeof category === 'string') {
        const c = category.toLowerCase();
        if (c.includes('payment') || c === 'payments-rails') subCatFilter = 'payments-rails';
        else if (c.includes('identity') || c.includes('compliance') || c === 'identity-compliance')
          subCatFilter = 'identity-compliance';
      }

      const snap = await db()
        .collection('organizations')
        .where('productType', '==', 'agent-tool')
        .get();

      type Candidate = {
        slug: string;
        name: string;
        description: string;
        homepage: string;
        agentReadiness: number;
        agentRationale: string;
        subCategory: string;
        useCaseFit: number;
        endpointCount: number;
        hitTokens: string[];
      };

      const useCaseTokens = tokenizeForOverlap(useCase);
      const candidates: Candidate[] = [];

      for (const d of snap.docs) {
        const data = d.data() as any;
        const slug: string = data.subdomainSlug;
        if (!slug) continue;
        const rating = getAgentReadiness(slug);
        if (!rating) continue; // only score vendors in the index
        if (subCatFilter && rating.subCategory !== subCatFilter) continue;

        // Load apiSurface for endpoint signals (best-effort)
        let endpointSummaries = '';
        let endpointCount = 0;
        try {
          const surf = await db().collection('apiSurface').doc(d.id).get();
          if (surf.exists) {
            const sd = surf.data() as any;
            const eps = (sd.endpoints || []) as Array<{ method: string; path: string; summary?: string }>;
            endpointCount = eps.length;
            endpointSummaries = eps.map((e) => `${e.path} ${e.summary || ''}`).join(' ');
          }
        } catch {}

        const corpus = `${data.description || ''} ${data.industry || ''} ${endpointSummaries}`;
        const corpusTokens = new Set(tokenizeForOverlap(corpus));
        const hits = useCaseTokens.filter((t) => corpusTokens.has(t));
        const useCaseFit = useCaseTokens.length === 0 ? 0 : hits.length / useCaseTokens.length;

        candidates.push({
          slug,
          name: data.companyName || slug,
          description: data.description || '',
          homepage: data.companyWebsite || '',
          agentReadiness: rating.score,
          agentRationale: rating.rationale,
          subCategory: rating.subCategory,
          useCaseFit,
          endpointCount,
          hitTokens: hits,
        });
      }

      // Combined score: 60% agent-readiness, 40% use-case fit. Tiebreaker = endpoint count.
      const scored = candidates
        .map((c) => ({
          ...c,
          combinedScore: Number((0.6 * c.agentReadiness + 0.4 * c.useCaseFit).toFixed(4)),
        }))
        .sort((a, b) => {
          if (b.combinedScore !== a.combinedScore) return b.combinedScore - a.combinedScore;
          return b.endpointCount - a.endpointCount;
        })
        .slice(0, cap);

      const ranked = scored.map((c, i) => ({
        rank: i + 1,
        slug: c.slug,
        name: c.name,
        homepage: c.homepage,
        subCategory: c.subCategory,
        score: c.combinedScore,
        agentReadinessScore: Number(c.agentReadiness.toFixed(2)),
        useCaseFitScore: Number(c.useCaseFit.toFixed(2)),
        rationale:
          c.useCaseFit > 0 && c.hitTokens.length > 0
            ? `${c.agentRationale} Matches your use case on: ${c.hitTokens.slice(0, 5).join(', ')}.`
            : c.agentRationale,
        blogUrl: `https://www.joinnextdev.com/a/${c.slug}`,
        llmsTxt: `https://www.joinnextdev.com/a/${c.slug}/llms.txt`,
        nextStep: `Call get_api_surface("${c.slug}") to ground the integration code.`,
      }));

      return {
        useCase,
        categoryFilter: subCatFilter || 'all',
        methodology:
          "Combined score = 60% agent-readiness (llms.txt quality, apiSurface structure, code-block stability, machine-readable auth) + 40% use-case keyword overlap with the vendor's description + endpoint summaries. Curated agent-readiness floors are calibrated against the Nextdev Agent Usability Index at /labs.",
        recommendations: ranked,
        count: ranked.length,
      };
    },
  },

  {
    name: 'compare_apis',
    description:
      'Adversarial side-by-side comparison of two API vendors in the Nextdev index. Returns dimension-by-dimension deltas (endpoint count, SDK depth, agent-readiness, auth model) plus a "choose X when…" rationale for each side. Use this when the developer asks "is A or B better for X" or "should I use Stripe or Adyen" — this is the comparison engine, not raw data dump.',
    inputSchema: {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'string', description: 'First vendor slug (e.g. "agentscore"). From list_orgs.' },
        b: { type: 'string', description: 'Second vendor slug (e.g. "stripe"). From list_orgs.' },
        use_case: {
          type: 'string',
          description:
            'Optional. Specific use case to weight the comparison toward (e.g. "AI agent identity verification").',
        },
      },
    },
    handler: async (args: Record<string, any>) => {
      const a: string = typeof args.a === 'string' ? args.a : '';
      const b: string = typeof args.b === 'string' ? args.b : '';
      const useCase: string = typeof args.use_case === 'string' ? args.use_case : '';

      const [orgA, orgB] = await Promise.all([resolveOrg(a), resolveOrg(b)]);
      const ratingA = getAgentReadiness(a);
      const ratingB = getAgentReadiness(b);

      const [sA, sB] = await Promise.all([
        db().collection('apiSurface').doc(orgA.id).get(),
        db().collection('apiSurface').doc(orgB.id).get(),
      ]);
      if (!sA.exists) throw new Error(`No apiSurface for "${a}"`);
      if (!sB.exists) throw new Error(`No apiSurface for "${b}"`);
      const surfA = sA.data() as any;
      const surfB = sB.data() as any;

      const epsA: Array<{ method: string; path: string; summary?: string }> = surfA.endpoints || [];
      const epsB: Array<{ method: string; path: string; summary?: string }> = surfB.endpoints || [];

      const useCaseTokens = new Set(tokenizeForOverlap(useCase));
      function filterByUseCase(eps: typeof epsA): typeof epsA {
        if (useCaseTokens.size === 0) return [];
        return eps.filter((e) => {
          const tokens = tokenizeForOverlap(`${e.path} ${e.summary || ''}`);
          return tokens.some((t) => useCaseTokens.has(t));
        });
      }
      const relevantA = filterByUseCase(epsA);
      const relevantB = filterByUseCase(epsB);

      const dimensions = [
        {
          dimension: 'Agent-readiness (Nextdev methodology)',
          a: ratingA ? `${(ratingA.score * 100).toFixed(0)}/100` : 'unrated',
          b: ratingB ? `${(ratingB.score * 100).toFixed(0)}/100` : 'unrated',
          winner:
            ratingA && ratingB
              ? ratingA.score > ratingB.score
                ? 'a'
                : ratingB.score > ratingA.score
                ? 'b'
                : 'tie'
              : 'unrated',
        },
        {
          dimension: 'Documented endpoint count',
          a: epsA.length,
          b: epsB.length,
          winner:
            epsA.length > epsB.length ? 'a' : epsB.length > epsA.length ? 'b' : 'tie',
        },
        {
          dimension: 'SDK methods documented',
          a: (surfA.sdkMethods || []).length,
          b: (surfB.sdkMethods || []).length,
          winner:
            (surfA.sdkMethods || []).length > (surfB.sdkMethods || []).length
              ? 'a'
              : (surfB.sdkMethods || []).length > (surfA.sdkMethods || []).length
              ? 'b'
              : 'tie',
        },
        {
          dimension: 'Real code samples extracted',
          a: (surfA.realCodeSamples || []).length,
          b: (surfB.realCodeSamples || []).length,
          winner:
            (surfA.realCodeSamples || []).length > (surfB.realCodeSamples || []).length
              ? 'a'
              : (surfB.realCodeSamples || []).length > (surfA.realCodeSamples || []).length
              ? 'b'
              : 'tie',
        },
        {
          dimension: 'Auth schemes',
          a: (surfA.authSchemes || []).join(', ') || 'undocumented',
          b: (surfB.authSchemes || []).join(', ') || 'undocumented',
          winner: 'tie',
        },
        ...(useCase
          ? [
              {
                dimension: `Endpoints matching use case ("${useCase}")`,
                a: relevantA.length,
                b: relevantB.length,
                winner:
                  relevantA.length > relevantB.length
                    ? 'a'
                    : relevantB.length > relevantA.length
                    ? 'b'
                    : 'tie',
              },
            ]
          : []),
      ];

      const aWins = dimensions.filter((d) => d.winner === 'a').length;
      const bWins = dimensions.filter((d) => d.winner === 'b').length;
      const overall = aWins > bWins ? 'a' : bWins > aWins ? 'b' : 'tie';

      return {
        a: {
          slug: a,
          name: orgA.companyName,
          homepage: orgA.companyWebsite,
          blogUrl: `https://www.joinnextdev.com/a/${a}`,
        },
        b: {
          slug: b,
          name: orgB.companyName,
          homepage: orgB.companyWebsite,
          blogUrl: `https://www.joinnextdev.com/a/${b}`,
        },
        useCase: useCase || null,
        dimensions,
        tally: { aWins, bWins, overall },
        recommendation: {
          chooseA: ratingA
            ? `Choose ${orgA.companyName} when you want: ${ratingA.rationale}`
            : `Choose ${orgA.companyName} when its higher endpoint count or SDK coverage matters.`,
          chooseB: ratingB
            ? `Choose ${orgB.companyName} when you want: ${ratingB.rationale}`
            : `Choose ${orgB.companyName} when its higher endpoint count or SDK coverage matters.`,
        },
        relevantEndpointsA: relevantA.slice(0, 5).map((e) => `${e.method} ${e.path}`),
        relevantEndpointsB: relevantB.slice(0, 5).map((e) => `${e.method} ${e.path}`),
      };
    },
  },
];

// ─── Dispatcher ─────────────────────────────────────────────────────────────

function ok(id: string | number | null, result: any): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: any
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });

      case 'tools/list':
        return ok(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const { name, arguments: args = {} } = req.params || {};
        const tool = tools.find((t) => t.name === name);
        if (!tool) return err(id, -32601, `Unknown tool: ${name}`);
        const result = await tool.handler(args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // Notifications take no response per JSON-RPC spec, but our HTTP
        // transport returns one anyway with no body.
        return ok(id, {});

      default:
        return err(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e: any) {
    return err(id, -32603, e?.message || 'Internal error', { stack: e?.stack });
  }
}
