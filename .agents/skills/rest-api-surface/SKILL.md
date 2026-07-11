---
name: rest-api-surface
description: Invariants, contracts, and file map for swarmy's public REST API — the SECOND front door (`@swarmy/api-rest`, `@hono/zod-openapi` → committed `openapi.json` → Go SDK → Terraform provider + Python/TS SDKs) that rides on the SAME org-scoped service layer as tRPC. Load before touching anything under packages/api-rest (routes/*, dto*.ts, mappers*.ts, problem.ts, middleware.ts, idempotency.ts, app.ts), packages/trpc/src/apiKeyContext.ts + apiKeys.service.ts, sdks/*, terraform-provider-swarmy/, or the `/api/v1` mount in apps/api. This is the REST/SDK/Terraform contract authority. Product rationale lives in docs/product/governance-and-access.md.
---

# REST API surface: one brain, two front doors

Read `docs/product/governance-and-access.md` for WHY swarmy is programmable and
who a key may act as. This skill is the HOW: the invariants that let a public,
versioned HTTP API + a Terraform provider exist over the dashboard's exact
service layer without ever forking business logic. REST is not a new subsystem —
it is a thin adapter in front of the same `*.service.ts` functions a feature
slice already built (see `skill("add-feature-slice")`); this skill is the
adapter contract.

## Invariants (violating any of these is a bug, not a style choice)

1. **Two front doors, one brain — handlers hold ZERO business logic.** Every
   REST handler in `packages/api-rest/src/routes/*` parses input, calls an
   existing `packages/trpc/src/services/*.service.ts` function (imported from
   `@swarmy/trpc`) with an `OrgContext`, maps the result to a DTO, and returns.
   If you find yourself branching on swarm state, dispatching an agent command,
   or touching Prisma inside a route, stop — that logic belongs in the service,
   called by both fronts. The services layer never learns it has two callers.
2. **A key becomes a principal at exactly ONE seam.**
   `resolveOrgContextFromApiKey` (`packages/trpc/src/apiKeyContext.ts`) turns a
   presented `swk_…` into the **same `OrgContext` shape** `orgProcedure` builds
   for a browser session. Wired in `apps/api/src/index.ts` as
   `createRestApp({ resolveContextFromApiKey })`. Never resolve a key anywhere
   else and never build a bespoke context for REST — downstream service calls
   must be byte-identical to a dashboard call.
3. **A key is org-scoped and never exceeds its creator's CURRENT authority.**
   One key → one org (`orgId` on the row); org isolation stays the hard
   boundary. The membership/role handed to services + ABAC is the creator's
   role resolved **at request time** (`db.member.findFirst`), never a frozen
   snapshot — a key cannot outlive the authority of the member who minted it.
   Revoked/expired keys resolve to `null` → 401. See `skill("auth-abac")` for
   the principal/PARC model REST plugs into.
4. **The Zod route definitions ARE the schema — one source, no drift.** Routes
   are declared with `createRoute(...)` (`@hono/zod-openapi`); the OpenAPI 3.1
   document is generated from those same schemas by `buildOpenApiDocument`
   (`app.ts`) and dumped to the committed `packages/api-rest/openapi.json`
   (`bun run --filter @swarmy/api-rest openapi:dump`). The spec cannot lie about
   validation because runtime validation and the spec come from one definition.
   Regenerate + commit `openapi.json` in the same PR as any route change; it is
   the codegen input for every SDK and the provider.
5. **Public DTOs are DELIBERATELY decoupled from `@swarmy/core` views.** Response
   shapes live as their own snake_case Zod schemas in `dto.ts` / `dto-extra.ts`;
   the camelCase-view→snake_case-DTO translation is absorbed by `mappers.ts` /
   `mappers-extra.ts`. An internal `views.ts` field can change without touching
   the public contract — that is the whole point. Request bodies reuse
   `@swarmy/core` `inputs.ts` **only** where the public shape should match the
   internal one (the anti-duplication win); otherwise a `*Body` DTO.
6. **One error mapper keeps both fronts consistent.** Services throw
   `TRPCError`s carrying a `swarmyCode`; `trpcErrorToProblem` (`problem.ts`) is
   the single map from tRPC code → HTTP status, emitting RFC 9457
   `application/problem+json` `{ type, title, status, detail, instance,
   swarmy_code }`. Never hand-roll an error body in a route — wrap the call in
   `run(c, fn, status)` (`respond.ts`) and let it map. A new `swarmyCode` is
   added in `@swarmy/trpc/errors`, not here.
7. **Keys mirror the join-token posture: hash-at-rest, prefix-display,
   plaintext-once.** `swk_<prefix>_<secret>` — the whole string is
   `hashToken`ed (sha256) and stored; only the `prefix` is displayed; the
   plaintext is returned exactly ONCE at creation and is never recoverable
   (`apiKeys.service.ts`). Scopes are `read` | `write`; `requireScope`
   (`middleware.ts`) gates each route (write implies read). Never return a key
   secret from a list/detail endpoint.
8. **Path-major versioning; `/api/v1` is frozen-additive.** REST mounts at
   `app.route('/api/v1', restApp)` in `apps/api/src/index.ts` — **no new server,
   no new port**, just more routes on the running controller. Within `v1` you
   add endpoints/optional fields freely; you never remove or repurpose a field
   or path. A breaking change is a `v2`, not an edit.
9. **Mutations are idempotent-replayable; reads are never commands.** A mutation
   (POST/PUT/PATCH/DELETE) carrying `Idempotency-Key` stores `(orgId, key) →
   (status, body)` and replays it verbatim on retry (`idempotency.ts`, runs
   AFTER auth). A key is bound to the first `(method, path)` it was used with —
   reusing it for a different op is `409 IDEMPOTENCY_KEY_REUSED`, never a silent
   wrong replay; only 2xx JSON is memoized. Reads (list/detail) are served by
   services from the hub snapshot, exactly as in `skill("agent-handlers")` — a
   GET never dispatches an agent command.
10. **The spec and docs stay public; only resource routes are authed.** Auth +
    idempotency middleware are applied inside `buildResourceApp(deps, true)`;
    `/api/v1/openapi.json` and the Scalar docs at `/api/v1/docs` are registered
    on the outer app and stay unauthenticated. Spec assembly (`withAuth=false`)
    never executes a handler, so the dump uses a stub resolver.

## Contracts between the layers

- **Host → REST**: `apps/api/src/index.ts` calls `createRestApp({
  resolveContextFromApiKey })`, passing the same `prisma`, `hub`, and
  `authRegistry.getAuth()` it already wires for tRPC. The `RestDeps` seam
  (`deps.ts`) is the *only* injection point — the package is framework-light and
  host-agnostic.
- **REST → services**: a handler gets `c.get('orgCtx')` (an `OrgContext`) and
  `c.get('apiKey')` (`{ id, scopes }`) off the Hono context (`RestEnv` in
  `middleware.ts`), then calls the service by name. Async mutations
  (create/scale/restart service, deploy stack) return `202` + a
  `DeploymentRefDto` (`{ id, deployment_id }`); clients poll the deployment to a
  terminal phase.
- **REST → wire spec**: the committed `packages/api-rest/openapi.json` is the
  contract artifact. `terraform-provider-swarmy/openapi.json` and the SDKs are
  generated from it (Speakeasy for Go; the Go SDK in `sdks/go` is reused as the
  provider's client). Provider/SDK auth is `Authorization: Bearer swk_…`.
- **Pagination envelope**: list endpoints return `{ data: [...], next_cursor:
  string | null }` via `listEnvelope(item, name)` (`dto.ts`). Cursor is opaque;
  today several lists return `next_cursor: null` (full page) — keep the envelope
  even so, so pagination can arrive without a contract break.

## File map

| Concern | Where |
|---|---|
| REST sub-app assembly, auth boundary, spec/docs mount | `packages/api-rest/src/app.ts` |
| Host injection contract (`RestDeps`, `ResolvedApiKey`) | `packages/api-rest/src/deps.ts` |
| Bearer-key auth + `requireScope` + `RestEnv` | `packages/api-rest/src/middleware.ts` |
| Idempotency-Key replay middleware | `packages/api-rest/src/idempotency.ts` |
| RFC 9457 problem mapper (`trpcErrorToProblem`) | `packages/api-rest/src/problem.ts` |
| `run()` — call service, encode, map errors | `packages/api-rest/src/respond.ts` |
| Resource routes (one module per resource) | `packages/api-rest/src/routes/*` |
| Public DTOs (snake_case Zod) | `packages/api-rest/src/dto.ts`, `dto-extra.ts` |
| view→DTO mappers (camel→snake) | `packages/api-rest/src/mappers.ts`, `mappers-extra.ts` |
| Committed spec artifact + dumper | `packages/api-rest/openapi.json`, `src/bin/dump-openapi.ts` |
| Key→OrgContext seam | `packages/trpc/src/apiKeyContext.ts` |
| Key lifecycle (mint/hash/list/revoke) | `packages/trpc/src/services/apiKeys.service.ts` |
| Dashboard key management router | `packages/trpc/src/routers/apiKeys.ts` |
| `/api/v1` mount + dep wiring | `apps/api/src/index.ts` |
| Generated SDKs | `sdks/go`, `sdks/python`, `sdks/typescript` |
| Terraform provider (SDK client + resources) | `terraform-provider-swarmy/internal/{client,provider}/*` |

## Adding a REST endpoint (the recipe)

1. **Confirm the service exists.** REST never adds capability — the
   `*.service.ts` function must already exist (build it as a feature slice
   first: `skill("add-feature-slice")`). If you're tempted to write logic in the
   route, that logic goes in the service.
2. **DTO(s)** in `dto.ts`/`dto-extra.ts`: a snake_case response schema
   `.openapi('Name')`, and a `*Body` request schema (or reuse an
   `@swarmy/core/inputs` schema if the public shape should match).
3. **Mapper** in `mappers.ts`/`mappers-extra.ts`: view/service-result → DTO. This
   is the only place camelCase→snake_case happens.
4. **Route** in `routes/<resource>.ts`: a `createRoute({ method, path, tags,
   security:[{ bearerApiKey:[] }], middleware:[requireScope('read'|'write')],
   request, responses })`, handler = `(c) => run(c, () => theService(c.get(
   'orgCtx'), input), status)`. Async mutation → `202` + `DeploymentRefDto`.
   Register the module in `buildResourceApp` (`app.ts`) if it's new.
5. **Regenerate the spec**: `bun run --filter @swarmy/api-rest openapi:dump` and
   commit `packages/api-rest/openapi.json` — this is the codegen input, so its
   diff IS the public-contract review.
6. **Verify**: `bun --filter @swarmy/api-rest typecheck` and the package tests
   (`idempotency.test.ts`, `mappers-extra.test.ts`). Round-trip a call with a
   real key: `curl -H 'Authorization: Bearer swk_…' localhost:3001/api/v1/nodes`
   (see `skill("run-local")`), and confirm the spec renders at
   `/api/v1/docs`.

## Operational gotchas

- **`swk_` not `swy_`.** The wire prefix in code is `swk_` (`API_KEY_PREFIX` in
  `apiKeys.service.ts`); the epic plan's `swy_` is stale. Grep for `swk_` when
  wiring leak-scanners or SDK examples.
- **Idempotency middleware needs a migrated model.** The `IdempotencyKey`
  delegate is reached through a narrow typed accessor (`models(db)` in
  `idempotency.ts`) until the Prisma migration lands — mirror that pattern,
  don't add the column to the committed schema prematurely.
- **Never widen a scope in a route to "make it work."** A GET is `read`, a
  mutation is `write`; if a key lacks the scope it's `403 POLICY_DENIED`, which
  is correct. Fine-grained ABAC attributes plug in at the `apiKeyContext` seam,
  not in the route.
- **DTO decoupling is load-bearing, not overhead.** When a view field is
  renamed, fix the mapper, not the DTO — the whole stability contract (and every
  downstream `terraform apply`) depends on the public shape holding still.
