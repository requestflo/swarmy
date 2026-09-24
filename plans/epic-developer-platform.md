# Epic: developer platform services

> Status: planned (owner-approved direction, 2026-09-24). Each section is one agent-sized
> chunk. Everything is self-hosted inside swarmy, with no third-party cloud
> (plans/self-reliance.md).

Order of work: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Design boards for 4–8 come first
(design canvas https://claude.ai/artifact/PS2nY46xC9r5Cj4gYtvf4y).

## 1. Zero-config builds (Railpack) + registry build cache
- Railpack (Railway's open-source builder, BuildKit frontend) for repos without a
  Dockerfile. Detection shows in the "New app from Git" wizard ("Detected: Next.js ·
  Node 22"). Overrides go in `swarmy.yaml` `build:`.
- Build cache: `--export-cache/--import-cache type=registry` to the in-swarm registry.
  Cache refs are cleaned by the existing image GC. Losing the cache only means a rebuild.

## 2. Auth for your apps (Better Auth, no code in the app)
- **Protect my app** (identity-aware proxy): Caddy `forward_auth` → swarmy Better Auth.
  Allowed people/groups come from ABAC. The app receives identity headers plus a signed
  JWT (JWKS served by swarmy). Toggle per app/route. This is the Cloudflare Access
  equivalent.
- **End-user auth as a resource**: `swarmy.yaml` `auth: { providers: [google, github,
  microsoft, oidc], email: magic-link }`. This deploys a per-app Better Auth service with
  its own DB, routes `/auth/*` on the app's domain, and ships a tiny SDK
  (`getSession(req)`). Social provider secrets are stored as Docker secrets.

## 3. Database studio (Prisma Studio / PlanetScale feel)
- Browse tables and documents, edit rows, SQL console, saved queries, slow-query
  insights. Covers managed Postgres, compose MySQL/MariaDB, Mongo and Redis/Valkey.
- Connections go through the agent on the DB's node (never public). Read-only by
  default. Writes need ABAC `data.write`. Every query is audited, with row limits and
  timeouts.

## 4. Developer CLI + MCP server
- `swarmy` CLI over the REST SDK: `login`, `deploy`, `logs`, `env pull`, `run`, `open`,
  `check`.
- MCP server: "will this repo work on swarmy?" (detect, Railpack plan, `swarmy.yaml`
  validate, optional trial preview deploy), deploys, logs, telemetry toggles. API keys
  are ABAC-scoped and read-only by default.

## 5. Session replay (rrweb), linked to telemetry
- The custom Caddy build (docker/caddy-swarmy) injects the rrweb recorder into HTML
  responses (replace-response module). It forces identity encoding upstream and handles
  CSP (a nonce, or a header rewrite for the recorder origin).
- Enabled per app or route. The app is never modified.
- Inputs are masked by default. Sampling rate, optional consent hook, retention limit.
- Ingest endpoint → event chunks in Garage, index in ClickHouse.
- The session id and `traceparent` link replays to traces and logs. The player UI shows
  the replay synced with requests, errors and logs.

## 6. Error tracking (Sentry-compatible, in-house)
- Accepts Sentry SDK envelopes (DSN per app), so existing SDKs work unchanged. Stored
  in ClickHouse. Grouping by fingerprint, releases (git sha), source maps uploaded from
  builds.
- Linked to the replay, trace and deploy that caused the error. Alerts through the
  existing channels.

## 7. Web analytics
- Injected through the same Caddy path as replay. Two modes per app:
  - **Privacy mode (default):** cookieless, no personal data, aggregate-only (visits,
    pages, referrers, countries via our own GeoIP). This is the kind of first-party
    audience measurement some EU regulators (e.g. CNIL) exempt from consent.
  - **Identified mode (opt-in):** ties visits to logged-in users (via item 2), sessions,
    replays and funnels.
- Legal note for the docs and UI: self-hosting avoids sending data to Google, but it
  does NOT by itself remove consent duties. EU ePrivacy covers storing or reading
  anything on the visitor's device, whoever processes it. GDPR covers personal data.
  Identified mode and session replay are personal data, so they need a legal basis or
  consent. The consent hook exists for that. Only the cookieless aggregate mode is
  plausibly banner-free.

## 8. Email service (SES-like)
- Native outbound mail: an SMTP endpoint plus an HTTP send API (and SDK), per-app
  credentials, templates, a suppression list, bounce/complaint webhooks, and a log of
  sent mail in ClickHouse.
- Domain setup via swarmy-dns: SPF, DKIM (keys in vault), DMARC. Guided checks for
  domains elsewhere.
- Deliverability caveat, stated plainly in the UI: many clouds (including DigitalOcean)
  block outbound port 25, and fresh IPs land in spam. Support a smarthost relay
  (any SMTP provider) as the send path when direct delivery isn't viable.
- Templates and apps get `SMTP_*` / `EMAIL_API_*` bindings automatically.

## 9. Managed queues (BullMQ) + queue studio
- `swarmy.yaml` `queue:` provisions a BullMQ-ready Valkey (managed, backed up) and binds
  `QUEUE_URL`.
- Queue studio (same feel as the DB studio): queues, job counts by state, job
  payloads, retry/promote/remove, failed-job inspection, rates, and pause/resume. Writes
  are ABAC-gated and audited.
- Existing queue-depth autoscaling (queue-reconcile) reads the same metrics.

## 10. Previews, extended
- Branch previews for any branch, not just PRs, with the same build and swarmy.yaml.
- Previews with data: fork the managed DB from the latest backup (reuses the
  restore-drill clone path).

## 11. AI gateway, extended (LiteLLM-class, built on what exists)
swarmy already ships an AI gateway (docs/product/ai-gateway.md, apps/api/src/ai-gateway.ts):
provider keys in the vault, per-app revocable virtual keys, attach-to-app, RPM + $ budgets,
exact-body cache, usage/cost and request logs. Extend it rather than deploy LiteLLM.
LiteLLM is Python, uses ~500 MB+ of RAM (too heavy for 1 GB nodes), and gates key features
behind an enterprise licence. Offer LiteLLM as a template for anyone who wants it.
- Providers: add Gemini, Bedrock, Azure OpenAI, Mistral, Groq, OpenRouter, plus
  **in-cluster models** (Ollama / vLLM templates auto-register as providers, reached over
  the overlay, not the internet).
- One OpenAI-compatible surface (`/ai/v1/chat/completions`, embeddings) that translates to
  every provider, alongside the native Anthropic path.
- Model catalogue + per-key/per-app **model allowlists**, aliases (`fast`, `smart`,
  `embed`), fallbacks and load-balancing across providers, and retries.
- `swarmy.yaml` `ai: { models: [smart, embed], budget: 5/day }`: binds `OPENAI_BASE_URL`,
  `ANTHROPIC_BASE_URL` and the key (as a Docker secret) automatically.
- ABAC `ai.use` on models; guardrails (PII redaction on logs, prompt-size caps).
- Traces: OTel GenAI semantic conventions into ClickHouse, linked to the calling
  request's trace. A playground in the dashboard to try any model with a key's limits.
- Semantic cache (optional, via the existing vector service).

## Also queued elsewhere
- Marketing site + docs on TanStack Start (apps/web today is Vite + React; docs from
  Markdown via a content package).
- Self-hosted NetBird: plans/epic-self-hosted-mesh-and-fleets.md.
- Platform upgrade button phases 2–3: plans/epic-platform-upgrades.md.
- Independent security review once auth, secrets and app auth land.
