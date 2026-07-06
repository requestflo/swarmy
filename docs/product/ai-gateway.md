# AI gateway — "one gateway: provider keys stay server-side, apps get revocable virtual keys"

**Status: canonical product design (2026-07). No dedicated skill — the how lives
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
   │  ⑤ cache: exact-body LRU (non-stream, 5-min TTL) — a hit costs nothing
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
  which is default, the audit/cache switches, and the stack→outlet-domain map.
  No secrets here.
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
  `429`, before the upstream call. Missing limits mean unlimited — opt-in caps,
  not mandatory ones.
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
| Unknown or disabled virtual key | `401` (unknown) / `403` (disabled) before any upstream call — no metering, no cost. |
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
- **Caching streams or partial matches.** Only exact non-streaming bodies are
  safe to replay; a "close enough" cache would return wrong answers.

## Implementation map

There is no dedicated skill for this unit — the code is the how, and it reuses
patterns documented elsewhere. Control plane (providers, keys, usage, logs,
settings, attach, stack grants, outlets):
`packages/trpc/src/services/ai.service.ts` +
`packages/trpc/src/routers/ai.ts`. Data plane (the proxy, auth, routing, limits,
metering, cache): `apps/api/src/ai-gateway.ts`, mounted at `/ai` in
`apps/api/src/index.ts`. Persistence: `packages/db/prisma/schema/ai.prisma`
(`AiProviderConfig` / `AiVirtualKey` / `AiUsage` / `AiRequestLog`); wire
types/inputs in `packages/core/src/views.ts` + `packages/core/src/inputs.ts`.
UI: `apps/app/src/routes/_authed/ai.tsx` → `apps/app/src/components/ai/*`
(providers, keys, usage charts, request log, settings, per-stack grant/outlet).

The **storage split** (encrypted controller-side keys in the DB vs the app-side
key in a Docker secret) is the `docker-native-storage` skill's DB-exception rule.
The **attach path** dispatches `secret.create` + `service.deploy` to the manager
node — the agent command contract in the `agent-handlers` skill. The overall
db→protocol→service→router→UI shape is the `add-feature-slice` skill. Note the
**outlet** overlap with the edge: an outlet domain renders one public gateway
vhost that proxies to the controller's `/ai/v1`, so it shares the single-vhost-
per-hostname rule with status pages and webhooks (see the `geo-edge-routing`
skill and `docs/product/edge-network.md`).
