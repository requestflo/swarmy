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
   `createRestApp({ resolveContextFromApiKey })` via
   `resolveOrgContextFromBearer` (same file), which also accepts an OAuth JWT
   swarmy's OIDC provider issued for its own APIs (scopes `swarmy:read` /
   `swarmy:write`, audience `<base>/api/v1` or `<base>/mcp`; verifier in
   `@swarmy/auth` `api-tokens.ts`, which refuses a JWT whose `iat` is at or
   before the user's `tokensRevokedAt`, stamped on sign-out and session
   revocation). Never resolve a key anywhere
   else and never build a bespoke context for REST — downstream service calls
   must be byte-identical to a dashboard call. The `/mcp` endpoint
   (`apps/api/src/devx.ts`) has no principal of its own: its tools call REST
   in-process with the caller's bearer.
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
   added in `@swarmy/trpc/errors`, not here. A validation 400 carries
   `invalid_params: [{ name, reason }]` (RFC 9457 §3): from the request-body
   hook's zod issues, or from a service that validates a whole write itself
   and throws with `cause.fieldErrors` (`invalid-params.ts` snake-cases the
   names) — so a refusal names every field, not just the first.
7. **Keys mirror the join-token posture: hash-at-rest, prefix-display,
   plaintext-once.** `swk_<prefix>_<secret>` — the whole string is
   `hashToken`ed (sha256) and stored; only the `prefix` is displayed; the
   plaintext is returned exactly ONCE at creation and is never recoverable
   (`apiKeys.service.ts`). Scopes are `read` | `deploy` | `write` |
   `secrets.read` (`API_KEY_SCOPES`, `@swarmy/core` `api-keys.ts`; the
   dashboard presets are Read-only, Deploy = read + deploy, Admin);
   `requireScope` (`middleware.ts`) gates each route by `scopeSatisfies`:
   write ⊇ deploy ⊇ read, and `secrets.read` stands alone. An OAuth token's
   `swarmy:write` maps to read + write. The MCP server
   (`packages/devkit/src/mcp/server.ts`) registers each tool only for the scope
   its REST route needs (`deploy`/`trial_deploy`/`env_set` need deploy;
   `telemetry_toggle`/`remove_stack` need write). Never return a key secret
   from a list/detail endpoint.
8. **Path-major versioning; `/api/v1` is frozen-additive.** REST mounts at
   `app.route('/api/v1', restApp)` in `apps/api/src/index.ts` — **no new server,
   no new port**, just more routes on the running controller. Within `v1` you
   add endpoints/optional fields freely; you never remove or repurpose a field
   or path. A breaking change is a `v2`, not an edit, with a deprecation
   window: wrap the v1 route in `deprecate({ since, sunset, successor?, link?
}, route)` (`deprecation.ts`) — the spec gets `deprecated: true` +
   `x-swarmy-deprecated`, and `deprecationSignals` (the first middleware)
   stamps `Deprecation` (RFC 9745) + `Sunset` (RFC 8594) + `Link` on every
   response of it, read back from the same marker. Nothing is deprecated yet.
   New enum values are documented as open, so adding one is non-breaking.
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
  (`deps.ts`) is the _only_ injection point — the package is framework-light and
  host-agnostic.
- **REST → services**: a handler gets `c.get('orgCtx')` (an `OrgContext`) and
  `c.get('apiKey')` (`{ id, scopes }`) off the Hono context (`RestEnv` in
  `middleware.ts`), then calls the service by name. Async mutations
  (create/update/scale/restart service, deploy stack) return `202` + a
  `DeploymentRefDto` (`{ id, deployment_id }`); clients poll the deployment to a
  terminal phase. `PATCH /services/{id}` is the twin of tRPC `services.update`
  (image, replicas, command, env incl. secret vars, `remove_secret_keys`,
  resources, restart policy, update order, labels; never ports, volumes,
  networks or placement): `deploy` scope + `requireAction('service.configure')`,
  and an admission refusal is a `412` carrying the violations.
- **Join tokens over REST** (`routes/join-tokens.ts`, thin over
  `token.service`): `GET /join-tokens` is `read`; `POST` is `write` +
  `requireAdmin()` (the `adminProcedure` twin) and answers `201` with the
  plaintext token ONCE, the mesh setup key when the org runs a mesh, and the
  controller URL the one-liner should use; `DELETE /join-tokens/{id}` is
  `write` + `requireAction('token.revoke')`. Only the hash is stored and the
  list never carries it; app-scoped keys are refused (org-wide routes,
  `app-scope.ts`).
- **REST → wire spec**: the committed `packages/api-rest/openapi.json` is the
  contract artifact. The SDKs' MODEL files (`sdks/{typescript/src/models.ts,
python/swarmy/models.py,go/models.go}`) are generated from it by
  `scripts/gen-sdks.ts`; their client/resource layers are hand-written and must
  gain each new route by hand — each SDK has a method for every route, and
  `scripts/check-sdk-parity.ts` (CI `sdks` job) fails on a route an SDK lacks
  or a call to a path the spec doesn't have, unless its `ALLOWLIST` names the
  route with a reason (today only `POST /nodes/{id}/cordon`, an alias of
  drain). It finds a method by its transport call, so write the path inline:
  `do(ctx, "GET", "/x/"+pathEscape(id), …)`, `request('GET', \`/x/${…}\`)`,
  `request("GET", "/x/{}".format(…))`. An optional `$ref`to an object becomes a Go pointer, and a`$ref` to a nullable object is nullable in every language. In a Go REQUEST
model (any schema a request body reaches) an optional boolean, or a number
whose bounds admit 0, is a pointer (`swarmy.Ptr(false)`; omitempty would drop
it), and an optional nullable field is `swarmy.Nullable[T]`+`omitzero`(unset is left out,`swarmy.Null[T]()`sends`null`): a nil pointer would
send `null` and clear what the caller never named. The Terraform
provider has its OWN hand-written client
(`terraform-provider-swarmy/internal/client/\*`) and keeps a copy of the spec
(`terraform-provider-swarmy/openapi.json`), refreshed with the contract.
Provider/SDK auth is `Authorization: Bearer swk\_…`.
- **Terraform resources ride existing routes**: `swarmy_service` applies image,
  env and command changes through one `PATCH /services/{id}` polled to
  convergence (a replica change alone stays a scale; a 412 lists each
  violation); `swarmy_join_token` mints, imports and revokes join tokens
  (`label`/`ttl_seconds`/`max_uses`/`profile` force a new token; the
  plaintext and mesh key are sensitive and returned once; one revoked outside
  Terraform is recreated); `swarmy_api_key` reads by listing `GET /api-keys`
  (there is no per-key GET) and drops a key revoked outside Terraform.
- **Pagination envelope**: list endpoints return `{ data: [...], next_cursor:
string | null }` via `listEnvelope(item, name)` (`dto.ts`). Cursor is opaque;
  today several lists return `next_cursor: null` (full page) — keep the envelope
  even so, so pagination can arrive without a contract break.

## File map

| Concern                                                                     | Where                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| REST sub-app assembly, auth boundary, spec/docs mount                       | `packages/api-rest/src/app.ts`                                                                                      |
| Host injection contract (`RestDeps`, `ResolvedApiKey`)                      | `packages/api-rest/src/deps.ts`                                                                                     |
| Bearer-key auth + `requireScope` + `RestEnv`                                | `packages/api-rest/src/middleware.ts`                                                                               |
| Idempotency-Key replay middleware                                           | `packages/api-rest/src/idempotency.ts`                                                                              |
| RFC 9457 problem mapper (`trpcErrorToProblem`)                              | `packages/api-rest/src/problem.ts`                                                                                  |
| Deprecation marker + `Deprecation`/`Sunset` headers                         | `packages/api-rest/src/deprecation.ts`                                                                              |
| `run()` — call service, encode, map errors                                  | `packages/api-rest/src/respond.ts`                                                                                  |
| Resource routes (one module per resource)                                   | `packages/api-rest/src/routes/*`                                                                                    |
| CLI/MCP developer routes (`/me`, env, logs + SSE, previews, telemetry)      | `routes/devx.ts` over `@swarmy/trpc/devx`                                                                           |
| Public DTOs (snake_case Zod)                                                | `packages/api-rest/src/dto.ts`, `dto-extra.ts`                                                                      |
| view→DTO mappers (camel→snake)                                              | `packages/api-rest/src/mappers.ts`, `mappers-extra.ts`                                                              |
| Committed spec artifact + dumper                                            | `packages/api-rest/openapi.json`, `src/bin/dump-openapi.ts`                                                         |
| Key→OrgContext seam                                                         | `packages/trpc/src/apiKeyContext.ts`                                                                                |
| Key lifecycle (mint/hash/list/revoke)                                       | `packages/trpc/src/services/apiKeys.service.ts`                                                                     |
| Dashboard key management router                                             | `packages/trpc/src/routers/apiKeys.ts`                                                                              |
| `/api/v1` mount + dep wiring                                                | `apps/api/src/index.ts`                                                                                             |
| SDKs (generated models + hand-written resources)                            | `sdks/go`, `sdks/python`, `sdks/typescript`; generator `scripts/gen-sdks.ts`                                        |
| Terraform provider (own client + resources, incl. `resource_join_token.go`) | `terraform-provider-swarmy/internal/{client,provider}/*`, examples `terraform-provider-swarmy/examples/resources/*` |
| Join tokens + service update routes                                         | `packages/api-rest/src/routes/{join-tokens,services}.ts`                                                            |
| App-scoped key guard (org-wide routes refused)                              | `packages/api-rest/src/app-scope.ts`                                                                                |

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
6. **SDK methods**: `bun run gen:sdks`, then add the route's method to each of
   `sdks/{go,python,typescript}` with a test, until `bun run
scripts/check-sdk-parity.ts` passes (`--table` prints route × SDK).
7. **Verify**: `bun --filter @swarmy/api-rest typecheck` and the package tests
   (`idempotency.test.ts`, `mappers-extra.test.ts`). Round-trip a call with a
   real key: `curl -H 'Authorization: Bearer swk_…' localhost:3021/api/v1/nodes`
   (see `skill("run-local")`), and confirm the spec renders at
   `/api/v1/docs`.

## Operational gotchas

- **`swk_` not `swy_`.** The wire prefix in code is `swk_` (`API_KEY_PREFIX` in
  `apiKeys.service.ts`); the epic plan's `swy_` is stale. Grep for `swk_` when
  wiring leak-scanners or SDK examples.
- **Idempotency rows are a real model now.** `IdempotencyKey` lives in
  `packages/db/prisma/schema/cluster.prisma`; `idempotency.ts` still reaches
  it through the narrow `models(db)` cast it was written with before the
  migration landed (a no-op today). A new model gets a migration
  (`bun run db:migration <name>`) in the same PR, not a cast.
- **Never widen a scope in a route to "make it work."** A GET is `read`;
  shipping (deploy, create or update a stack or service, env patch, scale, restart,
  previews, promote, confirming held steps) is `deploy`; every other mutation
  is `write`. If a key lacks the scope it's
  `403 POLICY_DENIED`, which
  is correct. Fine-grained ABAC attributes plug in at the `apiKeyContext` seam,
  not in the route.
- **DTO decoupling is load-bearing, not overhead.** When a view field is
  renamed, fix the mapper, not the DTO — the whole stability contract (and every
  downstream `terraform apply`) depends on the public shape holding still.
