# Epic Plan: GUI service/stack builder from the Swarm schema + two-way compose translation

## Problem

Today swarmy has two divergent, lossy paths to deploy a service:

1. A **hand-written React form** (`apps/app/.../services/new.tsx`) bound to `CreateServiceInput` (`packages/core/src/inputs.ts`). It covers only name/image/replicas/env/ports + an ingress toggle — a tiny fraction of what a Swarm `ServiceSpec` can express, and every new field means hand-editing JSX + the Zod input + the DB columns + `buildServiceSpec()`.
2. A **naive compose importer** (`composeToSpecs()` in `stack.service.ts`) that parses ~6 compose keys, drops everything else silently, hardcodes `tcp`/`ingress`, and has **no export path** — you cannot get a compose file back out, and re-importing a stack does not round-trip.

There is also no image discovery: users type `nginx:latest` blind, with no name or tag autocomplete.

The user-facing promise is "anyone can just deploy — it has to be that simple," and the architectural promise is **unopinionated** (stacks must run with or without swarmy). That means: (a) the GUI must cover the real Swarm/compose surface without becoming a JSON blob editor, (b) import→edit→export must be **faithful** (a compose file you bring in and re-export must still deploy on vanilla `docker stack deploy`), and (c) it must stay zero-config for the 90% case.

The core tension: a Swarm `ServiceSpec` has ~70 service-level fields with awkward union encodings (`list_or_dict`, string-or-number ports, shell-vs-exec command). We want a form that is **derived** from a schema (so coverage grows without bespoke JSX per field) yet still feels like a curated product, not a generic JSON-Schema form dump.

## Recommended approach

**Build a single canonical internal model — an extended Zod `ServiceSpec` in `@swarmy/core` — and treat both compose and the Swarm API `ServiceSpec` as *projections* of it.** The GUI form, the compose parser/serializer, and the agent dispatch all read/write this one model. No second source of truth.

Three sub-decisions, each with the alternative weighed:

### 1. Schema source: hand-authored Zod superset, *seeded* from the two upstream JSON Schemas — not generated from them

- **compose-spec** ([compose-spec.json](https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json)) is a Draft-07 JSON Schema with `$ref`/`definitions`/`oneOf` and the `list_or_dict` union helpers. It is the canonical *input* surface (what users paste).
- The **Docker Engine API `ServiceSpec`** (the `/services/create` body, dockerode's `CreateServiceOptions`) is the canonical *output* surface (what the agent applies). swarmy already has a partial hand-rolled subset of it in `core/src/protocol/commands.ts` + `toServiceCreateOptions()` in `core/src/docker.ts`.

  **Why not auto-generate the form schema from compose-spec.json at build time?** It is tempting (it is literally a JSON Schema), but: the union encodings (`oneOf` between `"8080:80"` strings and `{target,published}` objects) produce a terrible auto-form; field ordering/grouping/labels/help text are not in the schema; ~40 of the 70 fields are build-only or local-runtime-only (`build`, `develop`, `volumes_from`, `network_mode`) and are **meaningless under Swarm**, so a generated form would surface fields that silently no-op. A generated form fights the "curated, simple" goal.

  **Why not just extend the existing `ServiceSpec` Zod directly and skip compose-spec?** Because we need import fidelity — to round-trip a real compose file we must *recognize* keys we don't model and preserve them (see Round-trip below). We use the upstream schema as a **conformance checklist + a passthrough validator**, not as the form generator.

  **Decision:** A hand-authored Zod model (`ServiceModel`) in `@swarmy/core` that is the union of "what Swarm can do" ∩ "what compose can express," normalized to a single canonical shape (objects not unions: ports are always `{target,published,protocol,mode}`, env is always `Record<string,string>`). A small JSON-Schema-fixture test in CI asserts every compose-spec service key is either (a) mapped, (b) explicitly in a `passthrough` allowlist, or (c) explicitly in a `dropped-with-warning` list — so upstream additions can't silently regress coverage.

### 2. Form generation: a thin **field-descriptor registry**, not a generic JSON-Schema-to-form library

We drive the form from a typed array of **field descriptors** (`{ path, kind, label, help, group, advanced, condition }`) that map 1:1 onto the Zod model, rendered by a small set of `@swarmy/ui` field components (already have `Form`, `FormField`, `Input`, `Switch`, shadcn). This keeps RHF + `zodResolver` (already the project's pattern — see `new.tsx`) and gives us per-field control while still being **data-driven** (adding a field = adding a descriptor + a Zod field, not new JSX).

- **Why not `@rjsf/core` (react-jsonschema-form) or `@autoform/react`?** RJSF renders generic JSON Schema but produces a JSON-blob-flavored UI, can't reuse our shadcn field set without a full custom theme (which is as much work as the registry), and chokes on the `oneOf` unions exactly where compose is hairiest. AutoForm is closer (Zod-native) but still doesn't give us grouped tabs / "advanced" disclosure / conditional fields / the image autocomplete widget cleanly. A ~200-line descriptor registry we own is less total code than theming a generic lib and stays on-brand.
- **Why a registry at all vs. just more hand JSX?** Because the epic explicitly wants coverage to *grow* (phased schema coverage). The registry is the mechanism that makes "add a field" cheap and makes the **field list itself testable** (assert registry covers model).

### 3. The translation layer lives in `@swarmy/core` as pure functions, fully unit-testable

```
compose YAML  ──parse──▶  ComposeDoc (Zod, passthrough)  ──┐
                                                            ├─▶  ServiceModel[]  (canonical)
Docker ServiceSpec  ◀──inspect-normalize──  (live swarm)  ──┘
                              │
          ServiceModel  ──toServiceSpec()──▶  ServiceSpec (wire, existing) ──▶ agent ──▶ dockerode
          ServiceModel  ──toCompose()─────▶  compose YAML (export)
```

All four edges are pure functions in a new `@swarmy/core/compose` subpath. The agent does **not** change shape — it still receives the existing wire `ServiceSpec`; we only *extend* that spec's fields. This honors "the agent applies generic intent; new capabilities are new fields, not agent rewrites."

## Architecture & integration

### `@swarmy/core` — new canonical model + translation (the heart of this epic)

New files under `packages/core/src/`:

- **`model.ts`** — `ServiceModel` Zod schema: the canonical superset. Extends today's `ServiceSpec` shape with the Phase-1/2 fields (below). Normalized encodings only (no compose-style unions). This *replaces `CreateServiceInput` as the form's source of truth* — `CreateServiceInput` becomes a thin `ServiceModel.pick(...)` for back-compat during migration, then is retired.
- **`compose/schema.ts`** — `ComposeDoc` / `ComposeService` Zod with `.passthrough()` on every object, plus reusable `listOrDict` / `stringOrList` / `portShort` Zod transforms that normalize compose's union encodings into canonical objects on parse.
- **`compose/from-compose.ts`** — `composeToModels(yaml: string): { models: ServiceModel[]; warnings: TranslationWarning[]; unsupported: Record<string,unknown> }`. Replaces the toy `composeToSpecs()`.
- **`compose/to-compose.ts`** — `modelsToCompose(models: ServiceModel[]): string` (emits compose-spec v-current YAML via the `yaml` lib already in deps).
- **`compose/to-spec.ts`** — `modelToServiceSpec(model): ServiceSpec` (the wire spec). The existing `buildServiceSpec()` in `service.service.ts` collapses into this.
- **`fields.ts`** — the field-descriptor registry (consumed by the UI; lives in core so it's the single place that knows the model shape; pure data, no React).
- **`warnings.ts`** — `TranslationWarning = { level: 'info'|'warn'|'lossy'; path: string; code: string; message: string }`.

Wire-protocol `ServiceSpec` (`core/src/protocol/commands.ts`) gets **additive** fields so richer specs reach the agent: `entrypoint`, `user`, `workingDir`, `healthcheck`, `resources` (`limits`/`reservations` cpu+mem), `placement` (`constraints`/`preferences`), `updateConfig`/`rollbackConfig`, `labels` (have), `stopGracePeriod`, `configs`/`secrets` (later), `dnsConfig`, `hostname`, `tty`, `init`, `capAdd`/`capDrop`, `sysctls`. `toServiceCreateOptions()` in `docker.ts` extends to map these onto dockerode (`TaskTemplate.ContainerSpec.{Healthcheck,User,Dir,...}`, `TaskTemplate.Resources`, `TaskTemplate.Placement`, `UpdateConfig`, etc.). **No new message types** — these are fields on the existing `deployService`.

### `packages/db`

- **Stop spreading the spec across typed columns.** Add `Service.spec Json` (the canonical `ServiceModel`) as the source of truth; keep the existing scalar columns (`image`, `replicas`, `ports`, …) as **derived/denormalized** for list filtering/display (write them on save from the model). One migration, additive. `getServiceDetail` reads `spec` and returns it; `buildServiceSpec` is deleted.
- Stack already stores `composeSource Text` — good. Add `Stack.model Json` (the parsed `ServiceModel[]` + project-level networks/volumes) so the visual stack editor has structured state, with `composeSource` remaining the canonical exportable artifact (round-trip anchor).

### `packages/trpc` — routers/services

- **`services.create`/`update`** accept `ServiceModel` (replacing `CreateServiceInput`). `service.service.ts` persists `spec` + denormalized columns and calls `modelToServiceSpec()` → existing `ctx.hub.dispatch(node, 'service.deploy', …)`. Unchanged dispatch path.
- New **`builder` router** (`packages/trpc/src/routers/builder.ts`):
  - `parseCompose({ source }) → { models, warnings, unsupported }` (pure, no DB — used live as the user pastes; lets the UI show the lossy-field diff before committing).
  - `exportCompose({ serviceIds | stackId }) → { yaml }`.
  - `exportServiceSpec({ id }) → { spec }` (raw Swarm `docker service create`-equivalent, for power users / "show me the JSON" escape hatch).
  - `registry.searchImages({ query, registry? }) → ImageSuggestion[]` and `registry.listTags({ image, registry? }) → TagSuggestion[]` (autocomplete; see below).
- **`stacks.deployFromCompose`** now uses `composeToModels()` and persists per-service `spec`; round-trip warnings surfaced in the response.
- Audit: `service.builder.import`, `service.builder.export` actions into `auditLog` (org-scoped, per existing pattern).

### Autocomplete sourcing (`registry.service.ts` in trpc, server-side proxy)

The browser **must not** call Docker Hub directly (CORS + the token dance + we want shared caching). The controller proxies:

- **Image-name search:** `GET https://hub.docker.com/v2/search/repositories/?query=<q>&page_size=10` (Hub web API; anonymous; returns `repo_name`, `is_official`, `star_count`, `short_description`). Official images surface as `library/<name>` → display as bare `<name>`. (The registry-v2 `/_catalog` is **not** implemented by Hub, so the Hub web API is the only search path — confirmed in research.)
- **Tag listing:** `GET https://hub.docker.com/v2/namespaces/<ns>/repositories/<repo>/tags?page_size=25&ordering=-last_updated` (anonymous; newest-first, which is what an autocomplete wants).
- **Other registries:** for GHCR/Quay/private, fall through to the standard **Registry HTTP API v2** `GET /v2/<name>/tags/list` with a bearer-token handshake (`auth.docker.io/token?...` pattern for Hub-backed; `WWW-Authenticate`-driven for others). Name *search* is Hub-only; for other registries we only do tag completion on a fully-typed name. Registry base URL + optional creds come from the org's stored `RegistryAuth` (reuse the existing `RegistryAuth` Zod in `commands.ts`).

**Rate limits & caching (critical — research-grounded):** Hub now rate-limits anonymous pulls/requests (headers `ratelimit-limit`, `ratelimit-remaining`, windowed e.g. `100;w=21600`). Mitigation:
- **Controller-side cache** keyed by `(registry, query|image)`: search results TTL 5 min, tag lists TTL 60 s, in an in-memory LRU (same process style as the gateway's snapshot store) with a Postgres-backed fallback table optional later. One Hub call serves all org users.
- **Debounce** in the UI (250 ms) and require ≥2 chars before searching.
- **Honor `ratelimit-remaining`**: when low, serve stale-while-revalidate and stop background prefetch.
- If creds exist for the registry, authenticate the proxy calls (authenticated Hub limits are far higher).
- Autocomplete is **best-effort and non-blocking**: a failed/limited lookup never blocks deploy — the field is a free-text input with suggestions layered on top (degrade to plain `Input`).

### UI surfaces (`apps/app`)

- **`/services/new` and `/services/$serviceId/edit`** rebuilt as a `<ServiceBuilder model schema={fields} />` driven by the descriptor registry:
  - Grouped tabs: **General** (name, image+tag autocomplete, replicas/mode) · **Env** · **Networking** (ports, networks, hostname) · **Storage** (mounts) · **Resources** (cpu/mem limits+reservations) · **Scheduling** (constraints/placement) · **Health & lifecycle** (healthcheck, restart, update/rollback) · **Advanced** (caps, sysctls, user, init, …, collapsed by default).
  - **Image field** = combobox: type → `registry.searchImages` suggestions; once an image is chosen, the tag sub-field calls `registry.listTags`. (New `@swarmy/ui` `Combobox`/`ImagePicker` built on Radix popover + cmdk, project already has shadcn.)
  - **"Import compose"** button → paste/drag a file → live `parseCompose` → a **diff panel** showing mapped fields, lossy fields (`warn`), and dropped/unsupported keys (preserved but greyed) before the user commits. This is the killer two-way feature.
  - **"Export"** dropdown on any service/stack → Download `compose.yaml` (via `exportCompose`) or **"View as `docker service create`"** (raw spec) — the escape hatch that keeps power users happy and proves the unopinionated promise (the exported file runs without swarmy).
- **`/stacks`** gets a visual multi-service editor: add/clone services, shared project networks/volumes, with the same import/export. The compose textarea remains available as a "Source" tab (two-way: edits in either tab reconcile through the model).

## Round-trip fidelity (the make-or-break detail)

- **Preserve, don't drop.** `ComposeService` is `.passthrough()`; unknown/unsupported keys are captured into `model.unsupported` and re-emitted on `modelsToCompose()`. So import→export of a key swarmy doesn't model is byte-faithful at the key level.
- **Three-tier classification per compose key**, surfaced as warnings:
  1. *Mapped* — fully modeled + editable in GUI (e.g. `image`, `environment`, `ports`, `deploy.replicas`, `deploy.resources`, `healthcheck`).
  2. *Swarm-incompatible, preserved* — valid compose but ignored by Swarm (`build`, `depends_on` conditions, `volumes_from`, `network_mode: host` nuances): kept in `unsupported`, shown as `info`/`lossy`, **not** sent to the agent.
  3. *Lossy normalization* — e.g. compose `cpus: "0.5"` (string) → `resources.limits.cpus: 0.5` (number); re-export emits canonical form, semantically identical but not textually identical. Flagged `info`.
- **Golden round-trip tests** in `core`: a corpus of real compose files (official examples) run `parse → toCompose → parse` and assert model-level idempotency; plus `parse → toServiceSpec → toServiceCreateOptions` snapshot tests against dockerode shapes. CI asserts every compose-spec service key appears in exactly one tier (no silent gaps when upstream changes).
- **Canonical anchor for stacks:** the stored `composeSource` is the authoritative artifact; `model` is a cache. "Redeploy" re-parses source, so a user who hand-edits source is never overruled by stale model state.

## Validation

- One Zod model = one validator shared by the RHF resolver (client) and the tRPC `.input()` (server) — the project's existing "no drift" principle (`inputs.ts` header). Cross-field rules via `.superRefine` (e.g. `published` required when `mode: 'ingress'` and externally exposed; `mode: replicated` requires `replicas`; healthcheck `interval` ≥ `timeout`).
- Compose import has a **two-stage** validation: structural (is it valid compose per the upstream schema — show parse errors with line numbers from the `yaml` lib's CST) then semantic (does it map to a deployable Swarm spec — the warnings tiers). The user sees both before deploy.

## MVP vs later

**Phase 0 — model + plumbing (no new UI fields yet):** Introduce `ServiceModel`, `Service.spec` column, refactor `service.service.ts`/`stack.service.ts` to route through the model. Existing form/import keep working (same field set) but now on the new spine. De-risks everything downstream. Ship.

**Phase 1 — "common fields" coverage + image autocomplete:** Field registry + tabbed `ServiceBuilder` covering the high-frequency set: name, **image+tag autocomplete (Hub)**, replicas/mode, env, ports, mounts (volume/bind), networks, restart policy, resources (cpu/mem limits+reservations), placement constraints. Extend wire `ServiceSpec` + `toServiceCreateOptions` for resources/placement/restart. This is the "anyone can deploy visually" milestone.

**Phase 2 — two-way compose:** `composeToModels`/`modelsToCompose`, import diff panel, export menu, round-trip test corpus. Replace toy `composeToSpecs`. Visual stack editor.

**Phase 3 — long tail + extras:** healthcheck, entrypoint/user/workingDir, update/rollback config, caps/sysctls/init/tty, configs & secrets (needs Swarm config/secret CRUD — its own mini-epic), multi-registry tag completion (GHCR/Quay/private), "View as `docker service create`" raw export, secret-aware env (mark values secret → Swarm secrets later).

## Dependencies

- **Ingress epic / `ServiceIngressInput`:** the builder's "Networking/Ingress" tab must compose with the existing per-service ingress fragment (`inputs.ts` `ServiceIngressInput` → `Domain` rows). Keep ingress as a sibling section, not folded into the raw spec (it's swarmy intent, not Swarm spec). Coordinate field ownership.
- **Registry-auth / secrets epic:** private-image autocomplete and `pullImage` already use `RegistryAuth`; tag completion for private repos depends on where org registry creds live. Configs/secrets coverage (Phase 3) depends on a Swarm config/secret management capability not yet in the agent.
- **Agent capability:** extending wire `ServiceSpec` requires the agent's `executor.ts` deploy path + `toServiceCreateOptions` to map the new fields; gate behind protocol version so old agents reject unknown fields gracefully (use the existing `protocolVersions` handshake in `getNodeFacts`).
- **Infra:** controller needs **egress to `hub.docker.com` / `registry-1.docker.io`** (and the agent proxy/CA already present in this env). Autocomplete must degrade cleanly when egress is blocked (air-gapped installs).
- **`@swarmy/ui`:** new `Combobox`/`ImagePicker` + a `DiffPanel`/`WarningList` primitive.

## Risks & open questions

- **Docker Hub rate limits / ToS:** the search endpoint is undocumented-ish and unauthenticated limits tightened in 2025. Risk of throttling for busy orgs. Mitigation = aggressive controller caching + optional authenticated calls. Open Q: do we want a swarmy-hosted autocomplete proxy (cloud edition) to amortize limits across all installs? (Fits monetization.)
- **`ServiceSpec` surface creep:** every field added to the wire spec is a forward-compat contract with agents. Keep additive + version-gated; resist modeling Swarm minutiae that no real user touches.
- **Round-trip "fidelity" expectations:** users may expect byte-identical export. We guarantee *semantic* + *key-level passthrough* fidelity, not textual. Must be stated in the UI ("re-formatted, equivalent").
- **Compose features that are fundamentally non-Swarm** (`build`, `depends_on` ordering, `profiles`): do we (a) refuse, (b) import-and-warn, (c) for `build`, offer to point at a pre-built image? MVP = import-and-warn (tier 2). Open product Q.
- **Source-vs-model reconciliation in the stack editor** (two tabs editing the same thing) is the classic dual-representation bug farm. Decision: source is canonical, model is a view; switching tabs re-derives. Avoid live bidirectional sync.
- **Schema drift:** compose-spec and Docker API evolve. The CI conformance test (every key classified) is the guardrail; needs a maintainer to triage new keys.

## Simplicity note

The default path stays exactly as easy as today, and the new power is opt-in:

- **General tab alone deploys.** Name + image (with autocomplete so you don't even need to know the exact tag) + replicas → Deploy. Every other tab is optional and most fields have Swarm-default behavior when omitted (the Zod `.default()`s and `.optional()`s mean an empty advanced tab = today's behavior).
- **Advanced fields are collapsed** behind disclosure; a first-timer never sees `sysctls`.
- **Import is one paste.** Drop a `docker-compose.yml` you already have → GUI fills in → Deploy. No translation step the user has to think about; warnings are informational, never blocking.
- **The escape hatch proves the promise.** "Export compose" / "View as `docker service create`" means swarmy never traps your config — the artifact runs on plain Docker Swarm, reinforcing *unopinionated*. The model is a convenience over the canonical compose/spec, not a lock-in format.
- **Zero new required config:** autocomplete works anonymously out of the box (no API key), and silently degrades to a plain text field if egress is blocked — so an air-gapped one-command install still works.

---

Key existing files this epic modifies or replaces (all absolute):
- `/home/user/swarmy/packages/core/src/inputs.ts` — `CreateServiceInput` superseded by new `ServiceModel`.
- `/home/user/swarmy/packages/core/src/protocol/commands.ts` — additive fields on `ServiceSpec`.
- `/home/user/swarmy/packages/core/src/docker.ts` — `toServiceCreateOptions()` extended for new fields.
- `/home/user/swarmy/packages/trpc/src/services/service.service.ts` — `buildServiceSpec()` collapses into `core/compose/to-spec.ts`.
- `/home/user/swarmy/packages/trpc/src/services/stack.service.ts` — toy `composeToSpecs()` replaced by `composeToModels()`.
- `/home/user/swarmy/packages/trpc/src/routers/services.ts`, `/home/user/swarmy/packages/trpc/src/routers/stacks.ts` — accept `ServiceModel`; new `builder` + `registry` routers.
- `/home/user/swarmy/packages/db/prisma/schema.prisma` — add `Service.spec Json`, `Stack.model Json`.
- `/home/user/swarmy/apps/app/src/routes/_authed/services/new.tsx` (+ new `edit` route) and `/home/user/swarmy/apps/app/src/routes/_authed/stacks/index.tsx` — rebuilt on the field-descriptor `ServiceBuilder`.

New files: `packages/core/src/model.ts`, `packages/core/src/fields.ts`, `packages/core/src/warnings.ts`, `packages/core/src/compose/{schema,from-compose,to-compose,to-spec}.ts`, `packages/trpc/src/routers/{builder,registry}.ts`, `packages/trpc/src/services/registry.service.ts`, `@swarmy/ui` `Combobox`/`ImagePicker`/`DiffPanel`.
