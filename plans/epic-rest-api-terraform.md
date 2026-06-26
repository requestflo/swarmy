# Epic: Public REST API (OpenAPI) + Terraform provider

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11 over Hono on Bun, Prisma 7/Postgres, Better Auth + organization plugin, Zod-everywhere `@swarmy/core` inputs/views, the `publicProcedure → protectedProcedure → orgProcedure → adminProcedure` chain in `packages/trpc/src/trpc.ts`, the `@swarmy/trpc` routers→services split, the `AuditLog` model, and the `apps/api` Hono host that mounts `/api/auth/*` and `/api/trpc/*`). Do not redesign the scaffold; this epic adds a *second front door* (REST) onto the **same** services layer and a Terraform provider on top of it. It composes with the auth/ABAC epic (`plans/epic-auth-providers-abac.md`): API keys are a new principal type, and every REST mutation flows through the same authorization + audit seam.

## Problem

The dashboard talks to the controller over tRPC + superjson — a typed, batched, RPC-shaped, JS-only transport. That is correct for our own React app and useless to everyone else. To make swarmy *programmable* and to be taken seriously as infrastructure, we need a **stable, versioned, language-agnostic HTTP API with an OpenAPI contract**, plus the thing infra teams actually reach for: a **Terraform provider** so a node/service/stack/domain/ingress can live in `.tf` and be `plan`/`apply`/`destroy`-ed in CI alongside the rest of someone's infrastructure.

Concretely:
1. **No public REST surface.** tRPC's HTTP shape (`/api/trpc/{router}.{proc}?batch=1&input=…`, superjson-encoded, GET-for-queries/POST-for-mutations-by-convention-only) is an internal protocol, not a REST contract. curl, Python, Go, CI runners, and codegen tools can't reasonably consume it. There is no OpenAPI document, so there are no generated SDKs and no Terraform provider.
2. **No machine identity.** Every existing procedure authenticates via a Better Auth **session cookie** (`createContext` → `auth.api.getSession({ headers })`). Machines have no cookie. We need **API keys** scoped to an org, carrying permissions (ABAC), revocable, auditable — the same security posture as join tokens (hash, prefix, never-return).
3. **No stability contract.** The dashboard and tRPC router evolve freely (internal coupling is fine). A public API and a Terraform provider need **versioning, deprecation policy, and additive-only change discipline**, or every controller upgrade breaks users' `terraform apply`.
4. **No IaC story.** Self-hosters and the hosted cloud both want "describe my swarm in Terraform." Today there is nothing to point a provider at.

The hard part is doing all of this **without forking business logic**. The services layer (`packages/trpc/src/services/*.service.ts`) — `createService`, `scaleService`, `listNodes`, `generateJoinToken`, etc. — is the single source of truth, called today only by tRPC routers. REST must call the **same functions** with the **same `OrgContext`**, the same Zod inputs from `@swarmy/core`, the same error mapping (`errors.ts` → `swarmyCode`), and the same audit/ABAC. Two front doors, one brain.

## Recommended approach

### REST: **hand-author a thin REST router with `@hono/zod-openapi`, mounted in the existing Hono app, delegating to the services layer — not `trpc-openapi`, not a generated server.**

We already have Hono, Zod, and a clean services layer. The job is to expose those services over REST and emit an OpenAPI 3.1 document from the **same Zod schemas** that already define every input (`@swarmy/core` `inputs.ts`) and every view (`views.ts`). `@hono/zod-openapi` (with `@asteasolutions/zod-to-openapi` under the hood) does exactly this: you declare a route with a Zod request/response schema, you get runtime validation **and** a generated spec from one definition. No drift between docs and behaviour.

**The core move: a new `@swarmy/api-rest` package that is a registry of `createRoute(...)` definitions, each handler building an `OrgContext` from an API key and calling an existing `*.service.ts` function.** The handlers contain *zero* business logic — they are adapters: parse path/query/body (Zod), map to the service input type, call the service, map the service's view back to a REST DTO, map `TRPCError`/`swarmyCode` to an RFC 9457 problem response. The services layer never learns it has two callers.

Why hand-authored REST over the obvious "just transform tRPC" options:

- **`trpc-openapi` / `trpc-to-openapi`:** the tempting zero-effort path — annotate each procedure with `.meta({ openapi: { method, path } })` and it generates REST + a spec. Rejected as the primary mechanism because: (a) it couples our *public REST contract* to our *internal tRPC router shape*, exactly the coupling we need to avoid for a stability guarantee — every internal refactor risks the public path/verb; (b) its REST ergonomics are weak (flat-ish paths, awkward nesting, limited control over status codes, pagination envelopes, problem+json, and `Idempotency-Key`); (c) superjson + the trpc context machinery sit in the request path; (d) it's a community add-on with patchy OpenAPI 3.1 / maintenance vs `@hono/zod-openapi` which is first-party to the framework we already run. We keep the *schemas* shared (the real anti-duplication win) but own the REST surface deliberately.
- **OpenAPI-first with a generated server (write the spec, generate Hono/TS stubs):** rejected — inverts our source of truth. Our Zod schemas are already the contract; generating *from* them keeps one source. Spec-first shines when many teams negotiate an API up front; here one team owns both sides and the schemas already exist.
- **A separate framework (Fastify/Express + its OpenAPI plugin) in a new app:** rejected — needless second HTTP stack, second auth integration, second deploy. Hono is already the host; REST is just more routes on it.
- **GraphQL:** rejected for the public/IaC surface — Terraform providers, curl, and CI want plain resourceful REST; GraphQL adds a client runtime and doesn't map to Terraform's CRUD resource model. (A GraphQL gateway could be a later community/enterprise add-on, not the base.)

**Spec emission & docs.** `@hono/zod-openapi` exposes the assembled document at a route; we serve the JSON at `/api/v1/openapi.json` and render interactive docs with **Scalar** (`@scalar/hono-api-reference`, first-class Hono integration, nicer than Swagger UI) at `/api/v1/docs`. The spec is also written to a committed `packages/api-rest/openapi.json` artifact in CI (a test fails if the generated spec drifts from the committed one) so SDK/provider codegen and review have a stable file and breaking changes are visible in PR diffs.

### API auth: **Better Auth's first-party `apiKey` plugin for the key lifecycle, swarmy's ABAC for what a key may do, surfaced as a new `apikey` principal type in the same authorization seam.**

Better Auth ships an official `apiKey` plugin that handles generation, secure hashing-at-rest, prefix display, expiry, per-key metadata, rate-limiting, and verification (`auth.api.verifyApiKey({ key })`). We're already on Better Auth — adopt the plugin rather than hand-rolling a key table (we *would* hand-roll the exact join-token pattern — sha256 hash + stored prefix + never-return — and the plugin gives us precisely that, plus session-like verification, for free).

- **Wire format:** `Authorization: Bearer swy_<prefix>_<secret>` (a `swy_` prefix makes keys greppable in logs/leak-scanners; GitHub secret-scanning can be registered against it later). The REST layer's auth middleware extracts the bearer token, calls `auth.api.verifyApiKey`, resolves the key's `organizationId` and `creatorMemberId`, and **builds the same `OrgContext`** the tRPC `orgProcedure` builds — `{ db, hub, auth, activeOrgId, membership, … }` — so downstream service calls are identical to a dashboard call.
- **Scoping + ABAC:** a key is **org-scoped** (one key, one org — no cross-org keys; org isolation stays the hard boundary). Beyond that, a key carries **permissions** stored in its metadata: either a **role** (`owner|admin|member`, mapped to the same coarse tiers) for simple cases, or — when the ABAC epic lands — a set of **policy attributes** so a key can be *more restricted than its creator* (e.g. a CI key that may only `service.deploy` services labelled `env=prod`). The principal handed to the ABAC engine gets `principalType: "apikey"`, the key's attributes, and the key id (for audit). A key can **never exceed** the permissions of the member who created it (enforced at creation: requested scopes ⊆ creator's effective permissions). This is the ABAC epic's `abacProcedure`/PARC model with one new principal type — no second authz system.
- **Why not raw signed JWTs / OAuth client-credentials:** rejected for v1 — API keys are what infra users and Terraform expect (a single secret in an env var / CI secret), are trivially revocable (revoke = delete row), and the plugin already gives us secure storage + verification. OAuth2 client-credentials / OIDC machine tokens are a reasonable *enterprise* add-on later (issue short-lived tokens against a long-lived client), layered on the same principal model, but they're overkill for the one-command promise.
- **Rate limiting & abuse:** the `apiKey` plugin supports per-key rate limits; we set sane defaults (configurable per key) and return `429` with `RateLimit-*` headers. The hosted cloud can tighten these per plan.

### Versioning & stability: **URL-path major versioning (`/api/v1`), additive-by-default, explicit deprecation headers, a committed spec as the contract test.**

- **`/api/v1/...`** in the path. Path versioning (vs header/media-type versioning) is what Terraform providers and curl users expect and what tooling handles cleanly. `v1` is frozen-additive: we add endpoints/fields freely; we never remove or repurpose within a major.
- **Stability policy** documented in the spec description and `CONTRIBUTING`: additive changes (new endpoints, new optional fields, new enum values flagged as open) are non-breaking; breaking changes require `v2` and a deprecation window. Deprecated endpoints emit `Deprecation` + `Sunset` headers (RFC 8594) and an `x-swarmy-deprecated` extension in the spec.
- **Contract enforcement:** the committed `openapi.json` + a CI diff test (e.g. `oasdiff` for breaking-change detection) blocks accidental breaks. Field stability is also guarded by the fact that DTOs are explicit Zod schemas in `@swarmy/api-rest`, **decoupled from `@swarmy/core` views** — a view can change internally without changing the public DTO (the adapter absorbs it). This decoupling is the price we pay for stability and is worth it.

### Conventions: **resourceful paths, cursor pagination, RFC 9457 problem+json errors, `Idempotency-Key` for create.**

- **Paths:** `/api/v1/nodes`, `/api/v1/nodes/{id}`, `/api/v1/services`, `/api/v1/services/{id}`, `/api/v1/services/{id}/scale`, `/api/v1/stacks`, `/api/v1/domains`, `/api/v1/ingress`, `/api/v1/deployments/{id}`, `/api/v1/join-tokens`, etc. Sub-resources and actions (`/scale`, `/restart`, `/drain`) as `POST` action sub-paths (REST-pragmatic, not RPC-flat).
- **Pagination:** **cursor-based** (`?limit=&cursor=`) returning `{ data: [...], next_cursor: string|null }`. Opaque cursors (base64 of the keyset). Matches the existing `logsPage` shape (`{ items, nextCursor }`) and is stable under inserts (offset pagination is not). List endpoints get `limit` defaults/caps mirroring the tRPC inputs (e.g. `max(500)`).
- **Errors:** **RFC 9457 problem+json** (`application/problem+json`) with `{ type, title, status, detail, instance, swarmy_code }`. We already have the perfect source: `errors.ts` maps everything to a `TRPCError` + `swarmyCode` (`NODE_OFFLINE`, `NO_MANAGER`, `COMMAND_TIMEOUT`, `COMMAND_REJECTED`, `NOT_FOUND`, plus `POLICY_DENIED` from the ABAC epic). A single `trpcErrorToProblem(e)` maps tRPC codes → HTTP status (`UNAUTHORIZED`→401, `FORBIDDEN`→403, `NOT_FOUND`→404, `PRECONDITION_FAILED`→412, `TIMEOUT`→504, `BAD_REQUEST`→400, `CONFLICT`→409) and carries `swarmy_code` through. One mapping, both front doors stay consistent.
- **Idempotency:** mutating `POST`s accept an `Idempotency-Key` header; we store `(orgId, key) → response` for a TTL so a Terraform retry after a network blip doesn't double-create. Critical for IaC correctness.
- **Async operations:** deploys/scales are asynchronous (they dispatch agent commands and produce a `Deployment` with phases). REST returns `202 Accepted` with the deployment resource + a `Location: /api/v1/deployments/{id}`; clients poll `GET /api/v1/deployments/{id}` for terminal phase. The Terraform provider uses this poll loop in its create/update (Terraform expects synchronous-feeling resources — the provider blocks on the deployment reaching a terminal phase). A future SSE/webhook channel can replace polling without a contract break.

### Terraform provider: **hand-written Go provider on the Terraform Plugin Framework, calling a code-generated Go SDK (Speakeasy) produced from our OpenAPI spec.**

Two layers, deliberately split:

1. **A generated Go API client (SDK)** from `openapi.json` via **Speakeasy** (best-in-class TS/Go/Python SDK generation, good OpenAPI 3.1 support, idiomatic output, handles auth/pagination/retries). This is mechanical and regenerated on every API change — no hand-maintained HTTP code.
2. **A hand-written provider** using **`terraform-plugin-framework`** (HashiCorp's current-generation SDK; the older `terraform-plugin-sdk/v2` is legacy) that maps Terraform resources/data-sources onto SDK calls, owns the state model, the create→poll-deployment→read reconcile loop, import support, and plan/diff semantics.

Why **not** a fully generated provider:

- **Speakeasy / OpenAPI Terraform generators** *can* emit a whole provider from annotated OpenAPI (`x-speakeasy-entity` extensions). Genuinely attractive and we should **lean on it where it fits** — for the straightforward CRUD resources (`swarmy_domain`, `swarmy_join_token`, `swarmy_ingress`) generation is great and we'll annotate the spec to use it. But Terraform resource quality lives in the **non-CRUD parts**: async reconcile (deploy is a 202 + poll, not a synchronous PUT), drift detection (what does "this service changed outside Terraform" mean for replicas vs image vs env), `ForceNew` vs in-place update decisions, import IDs, and sensible plan diffs. Those are hand-written. So: **generated SDK always; generated resource scaffolding where the resource is plain CRUD; hand-written provider logic for everything with lifecycle nuance** (`swarmy_service`, `swarmy_stack`, `swarmy_node`).
- **`openapi-generator` Go client:** viable free alternative to Speakeasy for the SDK layer; weigh it on output quality. Decision: prefer Speakeasy for SDK ergonomics + it can *also* drive the simple-resource scaffolding from the same spec, single toolchain. Keep openapi-generator as the fallback if we want zero proprietary tooling in the build.

**Resources & data sources (v1):**

| Terraform resource | REST backing | Lifecycle notes |
|---|---|---|
| `swarmy_node` (+ `data.swarmy_node`) | `/nodes` | Nodes self-register via agent + join token; the resource mostly manages **labels/availability/removal**, not creation. `data.swarmy_node` for lookup. Creating a node = issuing a join token (below). |
| `swarmy_join_token` | `/join-tokens` | Create returns the secret **once** (write-only/`sensitive`); used to bootstrap agents in cloud-init/user-data. |
| `swarmy_service` | `/services` (+ `/scale`,`/restart`) | The flagship. Create/update → async deploy; provider polls `/deployments/{id}` to terminal phase. `ForceNew` on name/node; in-place on image/replicas/env. Drift read from `GET /services/{id}`. |
| `swarmy_stack` | `/stacks` | Compose-style multi-service bundle; same async deploy/poll. |
| `swarmy_domain` | `/domains` | Plain CRUD; pairs with ingress. |
| `swarmy_ingress` (config) | `/ingress` | Driver (caddy/traefik/none) + routes; renders config the agent applies. Plain-ish CRUD. |
| `swarmy_backup_target` | `/backup-targets` | **Depends on the volumes/DR epic** — include only once that REST exists. |
| `data.swarmy_*` for each | `GET list/detail` | Read-only data sources; ship in the read-only phase. |

Provider auth = `provider "swarmy" { endpoint = "https://controller…"; api_key = "swy_…" }` (api_key from `SWARMY_API_KEY` env). One org per key → provider operates within that org.

### SDKs: **generate TS, Python, and Go from the same spec with Speakeasy; publish on release.**

The OpenAPI spec gives SDKs nearly for free. **TypeScript** (for Node/Bun scripting and our own `apps/web` examples), **Python** (the ops/automation lingua franca), **Go** (reused as the Terraform provider's client). Generated in CI from the committed `openapi.json`, versioned to track the API, published to npm/PyPI/Go module on release (the repo already runs semantic-release). SDKs are downstream artifacts, not a separate design effort — listed here so the spec is treated as the product it is.

## Architecture & integration

### New package: `@swarmy/api-rest` (the REST surface; framework-light, services-backed)
- **`routes/` — one module per resource** (`nodes.ts`, `services.ts`, `stacks.ts`, `domains.ts`, `ingress.ts`, `deployments.ts`, `join-tokens.ts`, `metrics.ts`), each a set of `createRoute(...)` definitions (`@hono/zod-openapi`) with request/response **DTO Zod schemas**. Handlers call the **existing** `packages/trpc/src/services/*.service.ts` functions with an `OrgContext`. **No business logic here.**
- **`dto/` — public response schemas**, deliberately separate from `@swarmy/core` `views.ts` (stability decoupling) but built by mapping from views. Request bodies reuse `@swarmy/core` `inputs.ts` (`CreateServiceInput`, `UpdateServiceInput`, etc.) directly where the public shape should match — the anti-duplication win.
- **`context.ts` — `createApiContext({ headers, db, hub, auth }) → OrgContext`**: extracts the bearer key, `auth.api.verifyApiKey`, loads org + creator membership (and ABAC attributes), returns the *same* `OrgContext` shape the tRPC chain produces. This is the single seam where a key becomes a principal.
- **`problem.ts` — `trpcErrorToProblem(e)`**: the RFC 9457 mapper over `errors.ts` codes + `swarmyCode`.
- **`pagination.ts`, `idempotency.ts`** helpers (cursor encode/decode; idempotency store via a small Postgres table or the existing cache).
- **`openapi.ts`** assembles the document (info, servers, `securitySchemes: bearerApiKey`, tags per resource) and exposes it; a `bin`/test writes/checks the committed `openapi.json`.
- Depends on `@swarmy/trpc` (services), `@swarmy/core` (schemas), `@swarmy/db`, `@swarmy/auth`. **Reuses `OrgContext` and the service functions verbatim — the explicit goal.**

### `@swarmy/trpc` (minimal, additive)
- **Refactor the `OrgContext`-building logic out of `orgProcedure`'s middleware into a reusable `resolveOrgContext(base, orgId, userOrKeyPrincipal)`** so both the tRPC `orgProcedure` and `createApiContext` produce identical context (today the membership lookup is inline in `trpc.ts`). Small, mechanical, removes the only duplication risk.
- **`errors.ts`:** no change needed for REST itself (the problem-mapper lives in `api-rest`), but `SwarmyCode` is the shared vocabulary both fronts use. Add `POLICY_DENIED`/`UNAUTHORIZED_KEY` as the ABAC/key epics land.
- **`audit` writer** (the one introduced by the ABAC epic) is called by REST mutations too, with `actorType: "apikey"`, `actorId: keyId` — `AuditLog.actorType` already exists for exactly this. Closes "everything audited" for the API.
- New thin tRPC routers for **API key management from the dashboard** (`apiKeys.list/create/revoke`) so users mint keys in the UI — these wrap the Better Auth `apiKey` plugin admin API + ABAC scope validation.

### `@swarmy/auth`
- Add the **`apiKey()` plugin** to the Better Auth construction (in the dynamic builder if the auth-providers epic has landed; otherwise in `server.ts`). Configure prefix (`swy_`), hashing, optional rate-limit defaults, and the metadata shape (org role / ABAC attributes).
- `verifyApiKey` is the verification path used by `createApiContext`.

### `@swarmy/db`
- Better Auth's `apiKey` plugin **owns its table** (key hash, prefix, `organizationId`, expiry, metadata, rate-limit counters) — add it to the Prisma schema via the plugin's generated schema (same way the org plugin's tables live there). We do **not** hand-roll a key table.
- **New `IdempotencyKey` model** (`orgId`, `key`, `requestHash`, `responseBody`, `statusCode`, `createdAt`, `@@unique([orgId, key])`, TTL-swept by the existing retention worker) for create-idempotency.
- No other schema changes for REST; resource models (Node/Service/Stack/Domain/IngressConfig/Deployment) already exist and are what REST exposes. `backup_target` arrives with the volumes/DR epic.

### `apps/api` (host wiring — tiny)
- In **`index.ts`**, mount the REST router on the existing Hono app: `app.route('/api/v1', restApp)` where `restApp` is the `@hono/zod-openapi` app from `@swarmy/api-rest`. Serve `/api/v1/openapi.json` and `/api/v1/docs` (Scalar). The REST app builds context via `createApiContext` using the same `prisma`, `hub`, `auth` already imported for tRPC. **No new server, no new port** — REST is additional routes on the running controller. The agent WS gateway, tRPC mount, and auth mount are untouched.

### `apps/app` (UI surfaces)
- **Settings → API Keys:** list keys (prefix + label + last-used + scope/role), "Create key" (choose label, expiry, role or ABAC scope ⊆ caller), **show the secret once** with copy-to-clipboard + "store it now" warning (mirrors join-token UX), revoke. Powered by the new `apiKeys` tRPC router.
- **Settings → API & Integrations:** link to `/api/v1/docs`, a copyable curl example, links to SDKs + the Terraform provider registry page, and a "Generate Terraform starter" that emits a `provider {}` block + an example `swarmy_service` for the current org (the IaC on-ramp).

### New repo/build artifacts (outside the TS monorepo)
- **`packages/api-rest/openapi.json`** — committed spec (contract + codegen input + diff-gated).
- **`terraform-provider-swarmy`** — Go module (separate dir or repo) with the generated SDK + hand-written provider; `goreleaser` + Terraform Registry publishing.
- **SDK packages** (`@swarmy/sdk` TS, `swarmy` PyPI, `swarmy-go`) — generated, published on release.

### Protocol / agent
- **No new wire-protocol messages and no new agent capabilities.** REST and Terraform are pure controller-side front doors over existing services, which already dispatch the existing agent commands (`deployService`/`scale`/`restart`/...). A Terraform `apply` is just authenticated REST calls that funnel into the same dispatch path the dashboard uses. This is a deliberate scope boundary — the agent is unchanged.

## MVP vs later

**Phase 0 — foundation (spec + auth, no public mutations yet):** `@swarmy/api-rest` skeleton, `@hono/zod-openapi` wired into `apps/api`, `securityScheme` + `createApiContext` with the Better Auth `apiKey` plugin, the `apiKeys` tRPC router + Settings→API Keys UI, `problem.ts`, Scalar docs at `/api/v1/docs`, committed `openapi.json` + drift test.

**Phase 1 — read-only REST:** `GET` list+detail for nodes, services, stacks, domains, ingress, deployments, metrics, join-tokens; cursor pagination; problem+json. This is enough to ship **read-only SDKs** and **read-only Terraform `data` sources** (lookups), which alone are useful (reference an existing node/service in `.tf`). Lowest-risk way to validate the whole pipeline (spec → SDK → provider) end-to-end.

**Phase 2 — mutations:** `POST`/`PATCH`/`DELETE` + action sub-paths (`/scale`,`/restart`,`/drain`) reusing `inputs.ts` schemas and the service functions; `Idempotency-Key`; `202 + Location` async deploy semantics + `GET /deployments/{id}` poll. ABAC scope enforcement on keys. Full SDKs (TS/Python/Go) published.

**Phase 3 — Terraform provider:** Speakeasy Go SDK from the spec; `terraform-plugin-framework` provider with `data.swarmy_*` (uses Phase 1) then managed resources `swarmy_service`/`swarmy_stack`/`swarmy_node`/`swarmy_domain`/`swarmy_ingress`/`swarmy_join_token` (uses Phase 2) including async reconcile, drift read, import, `ForceNew` rules; acceptance tests against a dev controller; publish to the Terraform Registry.

**Phase 4 — polish/enterprise:** webhooks/SSE to replace deploy polling; per-key rate-limit tiers (hosted cloud); OAuth2 client-credentials for short-lived machine tokens; `swarmy_backup_target` (after volumes/DR); registered secret-scanning for `swy_` keys; spec `oasdiff` breaking-change gate in CI; optional `v2` machinery only when a real breaking change demands it.

## Dependencies
- **Auth/ABAC epic (`plans/epic-auth-providers-abac.md`):** soft dependency. REST works with the coarse `owner/admin/member` role on a key from day one; **fine-grained key scoping and the `audit` writer come from that epic**. The `apikey` principal type plugs into its `abacProcedure`/PARC model — coordinate the principal shape. The `AuditLog.actorType` field already supports `"apikey"`.
- **Volumes/DR epic:** `swarmy_backup_target` resource + `/backup-targets` REST wait on that epic's models/services.
- **Email/secret infra:** none required (API keys need no email; secrets stored by the Better Auth plugin).
- **`@swarmy/core` inputs/views** are the schema source — REST request DTOs reuse `inputs.ts`; response DTOs map from `views.ts`. Keep them Zod-complete (they already are).
- **CI/release (semantic-release already present):** add jobs to (a) generate + diff `openapi.json`, (b) generate + publish SDKs, (c) `goreleaser` the Terraform provider + Registry publish, (d) `oasdiff` breaking-change gate.
- **Toolchain:** Speakeasy (or openapi-generator fallback) for SDK/provider codegen; Go + `terraform-plugin-framework` for the provider; `@scalar/hono-api-reference` for docs.

## Risks & open questions
- **Async deploys vs Terraform's synchronous mental model.** The #1 provider-correctness risk. Mitigation: provider create/update **blocks on polling `/deployments/{id}`** to a terminal phase with a configurable timeout, surfaces phase/errors as Terraform diagnostics, and treats a failed deployment as a failed apply (so state isn't silently wrong). `202 + Location` is designed for exactly this.
- **Drift semantics for services.** What counts as drift when env/labels/replicas change out-of-band, and which fields are `ForceNew` vs in-place? Open question resolved per-field during Phase 3 (image/replicas/env = in-place; name/node = `ForceNew`); the `read` maps `GET /services/{id}` back to state carefully so unmanaged fields don't churn plans.
- **DTO ↔ view drift / double-maintenance.** Decoupling public DTOs from internal views buys stability but adds a mapping layer. Mitigation: a typed mapper + tests that round-trip view→DTO; keep DTOs minimal and additive. The cost is accepted deliberately (stability > zero-mapping).
- **Spec accuracy = everything downstream.** SDKs and the provider are only as correct as `openapi.json`. Mitigation: generate the spec from the same Zod schemas used at runtime (so it can't lie about validation), commit it, and gate it with a drift + `oasdiff` test.
- **Key permissions never exceeding creator.** Must enforce "requested scope ⊆ creator's effective permissions" at key creation, and re-evaluate if the creator's role is later reduced (a key outliving its creator's authority is a privilege-escalation hole). Open question: revoke/downgrade keys when creator membership changes? Lean: evaluate the key's *current* effective permission at request time against current org policy, not a frozen snapshot.
- **`trpc-openapi` temptation / partial adoption.** Risk that someone re-adds tRPC-derived REST for speed and reintroduces the coupling we rejected. Mitigation: the hand-authored route registry is the only sanctioned path; document why.
- **Better Auth `apiKey` plugin org-scoping.** Confirm the plugin cleanly associates a key with `organizationId` and exposes it in `verifyApiKey` (it supports metadata; verify the org linkage path during a spike). Fallback: store `orgId` in key metadata and resolve membership ourselves.
- **Idempotency correctness.** Replayed `Idempotency-Key` with a *different* body must error, not silently return the cached response. Mitigation: store + compare a request hash; mismatch → `422`.
- **Provider generation boundary.** Where exactly the Speakeasy-generated scaffolding ends and hand-written logic begins must be a clean seam, or regeneration clobbers hand code. Mitigation: generated SDK is fully regenerated; provider resource files are hand-owned and only *call* the SDK.

## Simplicity note
The REST API and Terraform provider are **purely additive** — they appear only when a user mints an API key, and the zero-config dashboard path is untouched (no key, no REST, nothing changes). Getting started is one toggle's worth of effort: create a key in Settings (copy it once, like a join token), then `export SWARMY_API_KEY=swy_…` and either `curl https://…/api/v1/services` or drop a four-line `provider "swarmy" {}` block in Terraform. The interactive docs at `/api/v1/docs` and a "Generate Terraform starter" button in the dashboard make the first call/`apply` copy-paste. Because REST rides on the *same* services, auth, and audit as the dashboard, there is no second system to learn or operate — and because every layer (keys, the REST surface, the provider) is opt-in and individually ignorable, the "anyone can just deploy" promise holds: the API is there when you want to automate, invisible when you don't.
