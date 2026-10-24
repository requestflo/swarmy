# AI gateway — "one gateway: provider keys stay server-side, apps get revocable virtual keys"

**Status: canonical product design (2026-07; extended 2026-09 to the
LiteLLM-class gateway — plans/epic-developer-platform.md §11). No dedicated skill — the how lives
in code; pairs with the `docker-native-storage`, `agent-handlers`, and
`add-feature-slice` skills for the storage split, the attach dispatch, and the
feature shape.**

## The feeling we are building

Someone running swarmy has a handful of apps that all want to call Claude and
GPT, and they want exactly one place where the provider keys live and the money
is counted:

1. On the **AI** page they paste their Anthropic key once. The copy is blunt:
   "Paste a provider API key once — apps never see it." A **Test** button fires
   one cheap 1-token call and comes back green with a latency.
2. They mint a **virtual key** named `worker`, give it 60 requests/minute and a
   $5/day cap. The plaintext `swk-ai-…` is shown **once**, in a reveal banner,
   then it is hash-only forever.
3. They hand that key (and the gateway URL, `…/ai/v1`) to the app — or better,
   they hit **Attach** and swarmy mints a per-app key, drops it in a Docker
   secret, and redeploys the service with `AI_GATEWAY_URL` already wired. The
   app's code points at swarmy instead of `api.anthropic.com` and nothing else
   changes.
4. Two weeks later the headline reads "**~$38.89** this fortnight." Usage by
   model, by key, by day; cache hits that cost nothing; a request log with a
   redacted 200-char prompt when they want the receipts. One key starts
   misbehaving → **Revoke**, and the gateway answers 403 for it on the next call.

The provider key never leaves the server. The app only ever holds a key swarmy
can kill. It should feel like **a valve you own**: one pipe every model call
flows through, metered and revocable, with the expensive secret on your side of
it.

## How it works (the request path)

```
app (holds only a virtual key swk-ai-…)
   │  ① POST …/ai/v1/messages   header: x-swarmy-ai-key: swk-ai-…
   ▼
swarmy gateway  (apps/api/src/ai-gateway.ts, spine-mounted at /ai on the controller)
   │  ② auth:  sha256(key) → AiVirtualKey.keyHash   (401 unknown · 403 disabled)
   │  ③ route: model prefix → provider   (claude* → anthropic, gpt*/o-series → openai,
   │           else the org default)     creds vault-decrypted from configEnc
   │  ④ limits: RPM sliding window + today's budget from AiUsage → 429
   │  ⑤ cache: exact-body LRU (org toggle, 5 min) · answer cache per route + key
   │           (same question, then similar via `embed`) — a hit costs nothing
   ▼
provider API  (api.anthropic.com / api.openai.com / custom base URL)
   │  ⑥ meter: static $/MTok table → one AiUsage row  (+AiRequestLog if audit on)
   ▼
response streamed back to the app  (SSE piped untouched; a bounded tail parses usage)
```

Three ideas, one story:

- **Provider keys stay server-side; apps get revocable virtual keys.** The
  Anthropic/OpenAI key is encrypted at rest and decrypted **only** inside the
  gateway process at proxy time — it never appears in a response, a label, or an
  app's environment. What an app holds is a `swk-ai-…` virtual key with its own
  rate limit and budget, that swarmy can disable in one click.
- **The gateway is the meter.** Every call writes one `AiUsage` row — provider,
  model, tokens in/out, latency, an **estimated** cost, and whether it was a
  cache hit. Cost is always an estimate off a static price table; the product
  never pretends the number is an invoice.
- **Attach makes the app side Docker-native.** Wiring an app doesn't hand a
  human a secret to paste — swarmy mints a dedicated key, stores it in a **Docker
  secret**, and redeploys the service with `AI_GATEWAY_URL` +
  `AI_GATEWAY_KEY_FILE`. The key lives in Docker on the app's side; re-attaching
  rotates it and retires the old one.

## The LiteLLM-class gateway (2026-09)

swarmy's gateway does what people deploy LiteLLM for, in the controller
process, without its RAM bill or enterprise licence:

- **Eleven providers.** Anthropic, OpenAI, Azure OpenAI (deployments +
  api-version), Google Gemini, AWS Bedrock (Converse, SigV4 or a Bedrock API
  key), Mistral, Groq, OpenRouter, any OpenAI-compatible base URL, and
  **in-cluster models**: an Ollama or vLLM service (the templates, matched by
  image or a `swarmy.ai.provider` label) registers itself from the live
  inventory — nothing is stored — and is reached by service name, not the
  internet. In-cluster calls cost nothing on the meter.
- **One OpenAI-compatible surface.** `/ai/v1/chat/completions` and
  `/ai/v1/embeddings` translate to every provider — requests, responses,
  streaming SSE chunks and tool calls. `/ai/v1/messages` stays native
  Anthropic (a passthrough to Anthropic, translated both ways for any other
  target). `GET /ai/v1/models` lists what a key may call. Stock SDK auth works:
  `Authorization: Bearer`, `x-api-key`, `api-key`.
- **Models.** A catalogue with a static price table (cost is still an
  estimate). Aliases `fast`, `smart`, `embed` resolve to every configured
  provider in preference order, so a fallback chain exists with zero config; an
  org route replaces an alias or adds a name, as an ordered **fallback** or a
  weighted **balance**. Each target gets retries with exponential backoff
  (`retry-after` wins); a busy/down target falls through to the next, a
  misconfigured one (401/403/404) is skipped at once, a client error (400) stops
  the chain. A target that keeps failing is cooled for 30s.
- **Allowlists.** A key carries a model allowlist (aliases, ids,
  `provider/model`, `provider/*`); an app (stack) can carry one too, and both
  must allow the call. Minting a key for a model checks the minter's `ai.use`.
- **Policy.** ABAC `ai.use` on the model (resource type `aiModel`, labels
  `swarmy.ai.provider`, `swarmy.ai.alias`, `swarmy.ai.cost` free|paid) for the
  member who minted the calling key and for whoever runs the playground.
  Members may use every model by default; an org narrows it with a forbid rule
  ("members use free models only"). Keys with no minter (older keys) are
  governed by their allowlists alone.
- **Guardrails.** A prompt-size cap (org-wide and per key; the tighter wins,
  `413`), and PII redaction on the request log (emails, phones, Luhn-valid
  cards, IBANs, SSNs, IPs, API keys, JWTs) — on by default.
- **Traces.** OTel GenAI semantic conventions (`gen_ai.operation.name`,
  `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.*`, …): a
  SERVER span per request as a child of the caller's `traceparent`, a CLIENT
  span per upstream attempt, exported as OTLP/HTTP JSON when
  `SWARMY_AI_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` is set, with
  `swarmy.org_id` / `swarmy.stack` resource attributes for the org-scoped
  trace views. Prompts never go on spans.
- **Playground.** The AI page runs a model under a chosen key's limits,
  server-side and in-process (no key in the browser), metered and traced like
  any call, showing which provider answered and how many attempts it took.
- **`swarmy.yaml`.** `ai: { models: [smart, embed], budget: 5/day }` binds
  every service (or `services: [...]`): `OPENAI_BASE_URL` (`…/ai/v1`),
  `ANTHROPIC_BASE_URL` (`…/ai`) and `AI_GATEWAY_URL` in env, and the service's
  own key as the secret variables `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` —
  Docker secrets exported by the app-secrets env shim, carried across every
  redeploy. The budget is shared by the app's keys. Changing the allowlist
  updates the key in place; it only rotates if its secret is gone.
- **LiteLLM itself** is a template for anyone who wants its UI.

**In-cluster reachability.** The controller lives on `swarmy-control`, which
user services may never join, so it reaches a registered engine at
`http://<service>:<port>` over **`swarmy-integrations`**: an encrypted overlay
(MTU sized for the mesh) that holds only the controller and the services it
must dial — the engines discovery registers, and the in-swarm hosts of alert
channels and outbound webhooks. Nothing of the control plane is on it, compose
may not declare it, and aliases on it are refused.

- The installer creates it and the stack file attaches the controller. On an
  install that predates it, the integrations reconcile (60 s,
  `integrations-network.ts`) adds the controller with one
  `docker service update --network-add` once a target exists.
- The same reconcile attaches each registered engine and detaches anything
  else it finds on the overlay. Apps are never attached by default.
- A compose deploy keeps a service swarmy attached on the overlay and puts a
  newly deployed engine on it in the same update (`integrations-carry.ts`), so
  redeploying the Ollama template never drops it for a tick or reloads the
  model twice.
- Only the engine discovery picks is attached: the first Ollama and the first
  vLLM by service name. A second one of the same kind is neither registered
  nor reachable.

Verified by unit tests only. Not verified without a multi-node swarm: name
resolution and calls from the controller task to an engine on another node
across the encrypted overlay, and the one-off controller network-add on an
older install.

## Roles and where truth lives

- **Provider API keys live in the DB, encrypted (`AiProviderConfig.configEnc`),
  NOT on a Docker label.** This is the deliberate exception to the
  `docker-native-storage` rule: a secret the **controller itself** must use
  server-side on every request — like session secrets and OAuth tokens — stays
  in the DB under the vault (`SWARMY_SECRET_KEY`), because the gateway data plane
  is the only thing that ever reads it. It is write-only from the UI's point of
  view: set it, test it, never read it back.
- **Provider descriptors + gateway toggles are plain config**
  (`AiProviderConfig.providersJson`): which providers exist, their base URLs,
  which is default, the audit/cache switches, which routes cache answers
  (`routeCache`), and the stack→outlet-domain map. No secrets here.
- **Cached answers live in the gateway's memory, nowhere else.** Prompts and
  answers are sensitive and short-lived run state, so they never go to the
  store, a label or a swarm config. A controller restart empties the cache and
  its counters together; the long-run hit rate comes from `AiUsage.cacheHit`.
- **Virtual keys are hashes** (`AiVirtualKey.keyHash`, sha-256 of `swk-ai-…`)
  plus a name, an optional `appRef`, and `limitsJson` (`rpm`,
  `dailyBudgetMicros`). The plaintext is returned exactly once at mint.
- **The app's copy of a key is Docker truth** — a Docker secret
  (`swarmy-ai-<stack>_<service>-key`) mounted into the service, marked with
  `swarmy.ai.inject` / `swarmy.ai.inject.key` labels. That side follows
  `docker-native-storage`; the controller's copy of the provider key does not.
- **Usage and the request log are swarmy's own history** (`AiUsage`,
  `AiRequestLog`) — queryable metering and an opt-in audit trail, exactly the
  "identity / access / audit / history" the DB is allowed to own.

## Gateway behaviour (what "one valve" commits us to)

- **Provider-shaped, not a new API.** The gateway speaks the providers' own
  routes — `POST /ai/v1/messages`, `/v1/chat/completions`, `/v1/embeddings` — so
  the only change an app makes is the base URL and the `x-swarmy-ai-key` header.
  Routing is by model prefix (`claude*`→anthropic, `gpt*`/`o1`/`o3`/`o4-mini`/
  embeddings→openai, everything else→the org's default provider).
- **Limits are per key, enforced at the edge of the proxy.** RPM is an in-memory
  60-second sliding window; the daily budget sums today's `AiUsage` cost (UTC
  day) and compares against `dailyBudgetMicros`. Either tripping is a clean
  `429`, before the upstream call. A key without its own `rpm` gets the
  controller default, 600/min (`SWARMY_AI_DEFAULT_RPM`; `0` or `off` for none),
  so a leaked or runaway key is bounded; a missing budget means no budget. An
  address that presents 20 bad keys in a minute gets `429` before any lookup
  (`apps/api/src/ai/limits.ts`).
- **Cost is honestly an estimate.** A static `$/MTok` table (longest-prefix
  match; unknown models bill at a middle rate) turns tokens into micro-dollars.
  Every usage view carries `costIsEstimate: true`; the UI says "cost est."
- **Streaming is sacred.** SSE responses are piped through **untouched** so
  latency and token-by-token UX are unaffected; usage is parsed best-effort from
  a bounded tail of the stream, falling back to a ~4-chars/token estimate. Only
  non-streaming responses are eligible for the cache.
- **The cache is exact-match and off by default.** Identical non-streaming
  bodies (scoped by org + path) served from a 5-minute LRU — "repeated calls cost
  nothing." It only runs when the org flips the cache toggle on.
- **The answer cache is opt-in per route and scoped per virtual key** (the AI
  page's Answer cache card; `ai.setRouteCache`, admin, audited). For a route
  that has it (`smart`, `fast` or an org route; a bare model id never caches),
  each non-streaming chat/messages request is looked up twice:
  1. *Same question.* The conversation is normalised (Unicode NFKC, line
     endings, trailing and repeated spaces; indentation, case and punctuation
     still count) and hashed with every parameter that changes the answer
     (model, temperature, tools, …; not `stream`, `user`, `metadata`).
  2. *Similar question* — only when the route sets a `similarity` threshold
     (0.8–0.999, default 0.95) and the org's `embed` route resolves and the
     key may use it (allowlists + ABAC). The last user message is embedded
     through `embed` (metered to the same key, so a free in-cluster embedder
     makes it cost nothing) and matched by cosine against answers stored under
     the same earlier conversation and parameters. Images or tool results in
     the last message mean same-question only.
  Answers are kept for the route's TTL (1 minute to 7 days, default 1 hour),
  in a 64 MB in-memory store with LRU eviction and at most 256 answers per
  key and route. A hit returns `x-swarmy-ai-cache: hit|similar` (plus
  `x-swarmy-ai-cache-score`), is metered as a free `cacheHit` row, and adds
  the estimated cost it avoided to the route's "saved" counter. The card
  shows each route's hit rate since the gateway started.
  Not built: storing the vectors in an in-swarm pgvector. The controller can't
  reach a managed vector store (its own overlay, and credentials in a Docker
  secret only attached apps mount), and keeping prompts in a user database
  is a separate decision, so the vector index stays in memory next to the
  answers.
- **The audit log is opt-in and redacted.** With the toggle on, each request
  writes one `AiRequestLog` row with the last user message truncated to 200
  chars. Off by default; prompts are never stored unless the org asks.
- **Revocation is immediate.** Disabling a key (or revoking a whole stack's
  grant) flips `disabled`; the very next call for that key gets `403`. Injected
  env on already-running services is harmless — the key it points at is dead.
- **Everything mutating is audited.** Provider set/remove/test, key mint/revoke,
  settings change, attach, stack grant/revoke, and outlet changes all write an
  audit row.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Unknown or disabled virtual key | `401` (unknown) / `403` (disabled) before any upstream call — no metering, no cost. 20 unknown keys from one address in a minute → `429` for that address. |
| Key over its RPM or daily budget | `429` with the reason; the upstream is never hit, so an over-budget app can't spend. |
| Provider unreachable / upstream error | `502` (or the upstream status); an `AiUsage` row is still written with `status: error` so failures show in usage. |
| No provider configured for the model | `400` "no provider configured" — the gateway refuses rather than guess. |
| Metering DB write fails | Swallowed — the proxied response is returned regardless. Metering must never break a request. |
| `configEnc` undecryptable (rotated `SWARMY_SECRET_KEY`) | Treated as "no key stored" → `400`; resolve by re-saving the provider key, never a silent wrong-key call. |
| Streaming response, usage unparseable | Falls back to a ~4-chars/token estimate; the request succeeds, the cost is approximate. |

## Explicitly rejected

- **Handing apps the provider key directly.** The entire point is that the
  expensive, un-revocable secret stays on the server. An app only ever holds a
  key swarmy can kill and cap.
- **Storing provider keys on a Docker label/secret like everything else.** They
  are consumed by the controller's own data plane on every request, so they live
  in the DB encrypted — the same class as sessions and OAuth. Pushing them to a
  node would mean the controller can't read them where it needs them. (The app's
  virtual key, which the app consumes, correctly IS a Docker secret.)
- **A bespoke gateway API.** Re-shaping requests would force every SDK to change.
  Mirroring the providers' own endpoints keeps the migration to "swap the base
  URL."
- **Billing as fact.** No live price feed, no invoice pretence — a static table
  and a loud "estimate." Users reconcile against the provider's real bill.
- **Caching streams, or "close enough" by default.** Only non-streaming
  answers are replayed. Similar-question matching can return an answer to a
  question that differs in a way that matters, so it is never on by itself:
  an admin turns it on per route, with a high threshold, and only for the
  same earlier conversation and parameters.

## Implementation map

There is no dedicated skill for this unit — the code is the how, and it reuses
patterns documented elsewhere. Pure model layer (providers, catalogue +
prices, aliases/routes, allowlists, in-cluster discovery, config and key-policy
codecs, PII redaction): `packages/core/src/ai-gateway.ts`. Control plane
(providers, routes, keys, usage, logs, settings, playground, attach, the
`swarmy.yaml` binding, stack grants, outlets):
`packages/trpc/src/services/ai.service.ts` + `packages/trpc/src/routers/ai.ts`;
the `ai:` schema is `packages/app-config/src/ai.ts`. Data plane (the pipeline,
auth, limits, metering, cache): `apps/api/src/ai-gateway.ts`, mounted at `/ai`
in `apps/api/src/index.ts`; translation per provider in `apps/api/src/ai/`
(`adapters.ts`, `anthropic.ts`, `gemini.ts`, `bedrock.ts`, `sigv4.ts`,
`framing.ts`), fallbacks/retries in `router.ts`, GenAI traces in `trace.ts`, the answer
cache in `route-cache.ts` (store) + `route-cache-plan.ts` (keys, lookup);
its pure keys/codec in `packages/core/src/ai-cache{,-stats}.ts` and its
control plane in `packages/trpc/src/services/ai-cache.service.ts`.
ABAC `ai.use` lives in `packages/abac`. Persistence: `packages/db/prisma/schema/ai.prisma`
(`AiProviderConfig` / `AiVirtualKey` / `AiUsage` / `AiRequestLog`); wire
types/inputs in `packages/core/src/views.ts` + `packages/core/src/inputs.ts`.
UI: `apps/app/src/routes/_authed/ai.tsx` → `apps/app/src/components/ai/*`
(providers, keys, usage charts, answer cache, request log, settings,
per-stack grant/outlet).

The **storage split** (encrypted controller-side keys in the DB vs the app-side
key in a Docker secret) is the `docker-native-storage` skill's DB-exception rule.
The **attach path** dispatches `secret.create` + `service.deploy` to the manager
node — the agent command contract in the `agent-handlers` skill. The overall
db→protocol→service→router→UI shape is the `add-feature-slice` skill. Note the
**outlet** overlap with the edge: an outlet domain renders one public gateway
vhost that proxies to the controller's `/ai/v1`, so it shares the single-vhost-
per-hostname rule with status pages and webhooks (see the `geo-edge-routing`
skill and `docs/product/edge-network.md`).
