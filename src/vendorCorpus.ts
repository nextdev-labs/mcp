/**
 * Vendor corpus for embedding-based recommend_api ranking.
 *
 * The `description` field returned by list_orgs is empty for ~99% of vendors,
 * so tokenizeForOverlap silently degrades to matching only endpoint path tokens.
 * This corpus provides rich, human-readable descriptions that embeddings can
 * match against paraphrased natural-language queries — the fix for the hard
 * query failure mode.
 *
 * Source: joinnextdev.com leaderboard + Agent Usability Index methodology page.
 */

export const VENDOR_CORPUS: Record<string, string> = {
  // Transactional email
  agentmail:  'AgentMail gives AI agents real email inboxes. Built for agents from day one: a clean SDK, llms.txt index, structured webhook events, and inbox-per-agent primitives that don\'t assume a human in the loop. Create, send, receive, and search messages via REST API.',
  resend:     'Resend is a clean modern email API with typed SDKs in six languages, React Email integration, and webhook events agents can subscribe to without ceremony. Transactional and marketing email for developers.',
  postmark:   'Postmark delivers transactional email with excellent deliverability, clear server token model, and structured bounce/delivery webhooks. Clean SDK, agent-callable.',
  sendgrid:   'SendGrid is a battle-tested transactional and marketing email platform at scale. REST API with v3 surface; large legacy endpoint set.',
  mailgun:    'Mailgun provides solid email routing and delivery primitives, with inbound email parsing and webhook forwarding.',
  brevo:      'Brevo (formerly Sendinblue) offers transactional email, SMS, and marketing automation with a REST API.',

  // Databases
  neon:        'Neon is serverless PostgreSQL with instant branching, scale-to-zero, and a clean HTTP driver. Every primitive maps to something an agent can call. Zero cold-start penalty on bursty workloads.',
  supabase:    'Supabase is Postgres-as-a-service with auth, storage, edge functions, realtime, pgvector, and docs agents can navigate by tool name.',
  turso:       'Turso is libSQL with edge replicas — strong primitives for edge-deployed agents and clean HTTP driver.',
  planetscale: 'PlanetScale is Vitess-backed MySQL with branching and deploy requests; integration mostly via standard MySQL drivers.',
  xata:        'Xata is branching Postgres with focused search story; smaller mindshare but clean API.',

  // Hosting & deploy
  vercel:  'Vercel is agent-native infra: ships MCP server, AI Gateway, Fluid Compute, AI SDK. The platform was deliberately retooled for the agent era. Deploy serverless functions, Next.js, and Python APIs instantly.',
  fly:     'Fly.io is a global app platform with Machines API agents can call directly; focused docs and clean deployment primitives.',
  railway: 'Railway is a modern PaaS with GraphQL API and concrete deployment primitives; clean and developer-loved.',
  render:  'Render is a modern Heroku-style PaaS with API and IaC blueprints; clean surface for agent deployment workflows.',
  netlify: 'Netlify is a JAMstack platform with broad surface for static sites and serverless functions.',

  // Identity & compliance
  agentscore:  'AgentScore is purpose-built for agents: clean MCP surface, an llms.txt index, and every endpoint and webhook documented for autonomous use. Identity verification and KYC for AI agents. Verify counterparty legitimacy before transactions.',
  stytch:      'Stytch provides modern auth primitives with typed SDKs; the emerging agent SDK shows clear agent-first thinking. Passkeys, magic links, OAuth.',
  withpersona: 'Withpersona (Persona) offers flexible KYC orchestration with strong primitives; agent-facing guidance improving and the API surface is clean.',
  alloy:       'Alloy is a powerful identity decisioning engine; agent-readiness limited by gated docs but the structured surface is genuinely strong.',
  plaid:       'Plaid provides mature identity and bank-data rails; connects to user bank accounts for balance, transactions, identity.',
  clerk:       'Clerk is a modern React-first auth with typed SDKs, hosted UI, and webhook events — agent integration paths documented end-to-end.',
  workos:      'WorkOS is enterprise auth done right: OpenAPI spec, deep SSO and SCIM docs, clean primitives.',
  auth0:       'Auth0 is an incumbent identity provider with deep docs; designed for browser-based flows.',

  // Payments
  soap:       'Soap is an agent-native checkout platform: idempotent payment intents, structured errors, and an llms.txt the model parses end-to-end. Built for autonomous buyers and sellers.',
  skyfire:    'Skyfire provides agent-to-agent payment rails with machine-readable auth flows; enables software processes to pay and receive payment autonomously.',
  stripe:     'Stripe is a deep payments platform with an Agent Toolkit, but agent-relevant flows are buried under a large legacy REST surface written for human integrators.',
  checkoutcom:'Checkout.com has a strong OpenAPI footprint, but the agent story relies on reading dense enterprise documentation written before agents existed.',
  adyen:      'Adyen provides enterprise-grade payment coverage, but dense docs and sparse machine-readable indices slow agents down.',
  'coinbase-cdp': 'Coinbase CDP ships Smart Wallets, Agent Kit, and explicit agent-first SDK — agent commerce is a named, first-class use case.',
  helio:      'Helio provides crypto payment links and invoicing, tightly scoped with well-documented primitives.',
  crossmint:  'Crossmint offers onboarding-first crypto with hosted checkout and wallets-as-a-service.',

  // Vector databases
  qdrant:      'Qdrant is a Rust-fast vector database with OpenAPI spec, gRPC and REST surface. Agent integration is concrete and well-marked. Store and retrieve high-dimensional embeddings for agent memory.',
  pinecone:    'Pinecone is the most mature managed vector database; SDKs are clean and the serverless v3 path is the agent-first one going forward.',
  weaviate:    'Weaviate is a multi-modal vector database with broad capabilities and modules; wide surface, well-marked agent flows.',
  turbopuffer: 'turbopuffer is a modern S3-backed vector database with focused API surface; concise docs.',
  chroma:      'Chroma is an embedded-first vector database optimized for local-dev experience; persistence and cloud story still evolving.',

  // LLM observability
  braintrust: 'Braintrust is an eval-first observability platform with typed SDKs, datasets, and scoring primitives — built for the way agents fail and improve.',
  langsmith:  'LangSmith is the most mature LLM observability platform for the LangChain ecosystem, with tracing, datasets, and eval primitives. Capture and replay multi-step reasoning chains.',
  langfuse:   'Langfuse is open-source LLM observability with clean API, self-host story, and agent-tracing primitives. Capture traces from multi-hop tool calls and reasoning steps.',
  helicone:   'Helicone is proxy-based LLM observability; OSS self-host and clean async log API.',
  lunary:     'Lunary is lightweight LLM analytics with a focused feature set.',

  // Agent frameworks
  mastra:     'Mastra is a TypeScript-first agent framework with typed tools, evals, and a clean llms.txt index.',
  llamaindex: 'LlamaIndex provides best-in-class RAG primitives with clean docs, workflows API, and structured-extraction patterns built for agent retrieval.',
  langchain:  'LangChain is the most popular agent framework with vast integrations and llms.txt.',
  crewai:     'CrewAI offers role-based multi-agent orchestration with usable docs.',

  // Web scraping
  firecrawl:   'Firecrawl is agent-native by design: clean LLM-ready markdown output, scrape, crawl, and extract primitives, and a first-class MCP server.',
  browserbase: 'Browserbase is a headless browser cloud built for agents with Stagehand integration and session inspector.',
  browseruse:  'BrowserUse is a browser-driving agent framework with hosted API.',
  hyperbrowser: 'Hyperbrowser is a modern browser cloud with stealth, residential proxies, and an agent SDK.',
  scrapingbee: 'ScrapingBee is a classic scraping API with reliable surface and good docs.',

  // Search
  meilisearch: 'Meilisearch is a modern open-source search with great defaults, typo tolerance, and a clean REST API.',
  typesense:   'Typesense is Algolia-style hosted search with OSS self-host and concrete REST surface.',
  algolia:     'Algolia is a search incumbent with rich SDKs; surface scope is wide.',

  // Analytics
  posthog:   'PostHog is product analytics, session replay, feature flags, and experiments in one — broad agent-callable surface.',
  mixpanel:  'Mixpanel is a mature analytics surface.',
  amplitude: 'Amplitude is deep product analytics.',
  segment:   'Segment is a CDP with stable Track/Identify primitives.',

  // Feature flags
  statsig:      'Statsig provides feature flags and experiments tightly integrated with analytics.',
  launchdarkly: 'LaunchDarkly is an enterprise flagging incumbent with deep targeting features.',

  // Monitoring
  sentry:     'Sentry provides error tracking, performance monitoring, and session replays with best-in-class SDKs.',
  honeycomb:  'Honeycomb is wide-event observability with BubbleUp and structured event analysis.',
  datadog:    'Datadog is the industry-leading observability platform with enormous catalog.',
  betterstack: 'Better Stack offers modern logs, uptime, and status pages with clean SDKs.',

  // Object storage
  'cloudflare-r2': 'Cloudflare R2 is S3-compatible object storage with zero egress fees and Workers integration.',
  uploadthing: 'UploadThing is an opinionated upload service with typed React/Next.js integration.',
  tigris:      'Tigris is globally distributed S3-compatible storage.',

  // Speech
  elevenlabs: 'ElevenLabs provides best-in-class TTS with conversational AI primitives and agent-callable WebSocket streaming.',
  deepgram:   'Deepgram is the streaming STT leader with concrete agent docs and structured webhooks.',
  cartesia:   'Cartesia provides modern low-latency TTS with Sonic models and a clean realtime API.',
  assemblyai: 'AssemblyAI is a solid speech-to-text platform.',

  // SMS/voice
  twilio: 'Twilio is the industry-leading programmable SMS, voice, and messaging platform with vast SDKs.',
  telnyx: 'Telnyx provides modern programmable voice and SMS APIs with clean OpenAPI spec.',
};

/** Scores from the Nextdev Agent Usability Index leaderboard. */
export const AGENT_READINESS_CORPUS: Record<string, number> = {
  agentmail: 0.94, resend: 0.92, postmark: 0.90, sendgrid: 0.84, mailgun: 0.83, brevo: 0.82,
  neon: 0.91, supabase: 0.91, turso: 0.88, planetscale: 0.87, xata: 0.84,
  vercel: 0.93, fly: 0.89, railway: 0.87, render: 0.86, netlify: 0.83,
  agentscore: 0.96, stytch: 0.88, withpersona: 0.87, alloy: 0.86,
  plaid: 0.84, clerk: 0.90, workos: 0.87, auth0: 0.84,
  soap: 0.93, skyfire: 0.88, stripe: 0.85, checkoutcom: 0.83, adyen: 0.83,
  'coinbase-cdp': 0.92, helio: 0.85, crossmint: 0.87,
  qdrant: 0.91, pinecone: 0.89, weaviate: 0.88, turbopuffer: 0.88, chroma: 0.86,
  braintrust: 0.91, langsmith: 0.90, langfuse: 0.90, helicone: 0.88, lunary: 0.81,
  mastra: 0.92, llamaindex: 0.89, langchain: 0.86, crewai: 0.83,
  firecrawl: 0.93, browserbase: 0.91, browseruse: 0.89, hyperbrowser: 0.89, scrapingbee: 0.85,
  meilisearch: 0.91, typesense: 0.88, algolia: 0.85,
  posthog: 0.91, mixpanel: 0.83, amplitude: 0.84, segment: 0.85,
  statsig: 0.88, launchdarkly: 0.84,
  sentry: 0.91, honeycomb: 0.89, datadog: 0.85, betterstack: 0.87,
  'cloudflare-r2': 0.89, uploadthing: 0.87, tigris: 0.84,
  elevenlabs: 0.92, deepgram: 0.91, cartesia: 0.90, assemblyai: 0.87,
  twilio: 0.86, telnyx: 0.88,
};

export const DEFAULT_READINESS = 0.75;
