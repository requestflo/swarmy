# Deploy & releases — "paste your compose, deploy visually, never get locked in"

**Status: canonical product design (2026-07). Pairs with the `add-feature-slice`
and `docker-native-storage` skills for the how.**

## The feeling we are building

Someone who already has a `docker-compose.yml` should get it running on their
swarm without learning swarmy's shape first — and should be able to leave with
the exact file they came with:

1. They open a stack workspace. The **Overview tab is a live canvas**: draggable
   service cards (`web · ghcr.io/northwind/web:1.8.2 · 3/3 up · :3000`), dependency
   lines between them, per-replica status dots, a **scale-to-zero** badge on the
   idle `cdn-edge`, and an **OTEL** on/off toggle in the corner. Ports, images,
   replicas, and edges are all readable at a glance.
2. They hit **Import compose**, paste their file, and watch it resolve into cards
   — mapped fields filled in, lossy/unsupported keys flagged but *preserved*, not
   dropped. Or they start from a **blueprint** ("one form, one Deploy") and get a
   parameterised app wired to managed data + ingress in a few steps.
3. They **Deploy** (one coral CTA). The change runs the admission pipeline first;
   a blocking guardrail is refused with a plain-words reason and an admin override
   on the record. The deploy lands as a **Release** — image refs, `+N services`,
   the actor's email, a status dot.
4. The **Releases tab** watches the new release against the stack's health for a
   window and **auto-rolls-back** if it degrades. For a risky change they run a
   **canary**: `stable 90% / canary 10% · 9m left of 15m · rolls back over 5%
   errors · live on shop.northwind.dev` → **Promote now** or **Abort**.
5. Any time, **Export compose** or **View as `docker service create`** hands back
   an artifact that runs on vanilla Docker Swarm. The stack keeps running if
   swarmy vanishes. No lock-in was ever taken.

No YAML-in-a-textarea as the only door. No swarmy-only manifest format. No deploy
that can't be seen, judged, and undone. It should feel like a visual editor bolted
onto plain compose — because that is exactly what it is.

## How it works (paste → canvas → admission → release)

```
compose YAML ─composeToModels─▶ ServiceModel[] (canonical, @swarmy/core/compose)
   ▲  Import compose            │  drag/edit on the CANVAS · scale-to-zero · OTEL
   │  Export / "docker           ▼
   │   service create"     modelToServiceSpec() ──▶ ServiceSpec[] (the wire spec)
   └──modelsToCompose()          │
                                 ▼
                     evaluateAdmission()  ── guardrails · exposure · image policy
                                 │  block → admin override (audited); warn → any-member override
                                 ▼
              ctx.hub.dispatch(node,'service.deploy') ──▶ agent ──▶ local Docker
                                 │
                                 ▼
                     recordRelease() ──▶ Release row (history) + swarmy.deploy.* labels
                                 │
              ┌──────────────────┴───────────────────┐
     deploy-safety worker                     deploy-canary worker
     (health gate → HEALTHY / auto-rollback)  (window/error-rate → promote / rollback)
```

Four ideas, one story:

- **One canonical model, three projections.** compose, the Swarm `ServiceSpec`,
  and the GUI form are all *views* of a single Zod `ServiceModel`
  (`@swarmy/core/compose`). Import parses compose → model; export serialises model
  → compose; deploy projects model → wire spec. There is no swarmy-only format in
  the middle — which is why "the exact stack runs without swarmy" is a guarantee,
  not a slogan.
- **Reads are the canvas; only Deploy mutates.** The canvas is rendered from the
  hub's live inventory (Docker truth) — dragging a card writes only a `CanvasLayout`
  position, never a spec. A real change is one `service.deploy` dispatch. See
  `skill("agent-handlers")`.
- **Every deploy is admitted, then remembered.** The admission pipeline judges the
  specs before dispatch; the `Release` row records who shipped what compose, which
  image digests, and how the gate judged it — swarmy's own queryable history.
- **The stack owns its own release policy.** The health gate, deploy strategy, and
  live canary all live on the stack's Docker labels — so "watch this release, roll
  back if it degrades" survives a wiped controller database.

## Roles and where truth lives

- **Live services, replicas, and stack membership are Docker truth**, read from
  the hub's inventory each time — never a DB mirror. Stack membership is the
  `com.docker.stack.namespace` / `swarmy.stack` label; `swarmy.managed=true` marks
  a swarmy-deployed service. A "deployment" is *synthesised* from replica
  convergence (`deployment.service.ts`), not a persisted row.
- **Release policy is stack-level Docker labels**: the health gate
  (`swarmy.deploy.safety` — `{windowSec, autoRollback}` JSON) and deploy strategy
  (`swarmy.deploy.strategy`) are stamped on every service in the stack; canary
  state is `swarmy.canary.of` (which stable a `<svc>--canary` sibling shadows) +
  `swarmy.canary.params` (traffic %, window, error-rate trip). Per-service
  behaviour like `swarmy.scaleToZero` and `swarmy.otel.enabled` are labels too. See
  the `docker-native-storage` skill.
- **What swarmy's DB owns is its own identity + history + convenience state**: the
  `Release` model (compose snapshot, resolved image refs, actor, strategy, gate
  verdict, status — the queryable "who shipped what, when"); the `Stack` config row
  (its `composeSource` is the authoritative exportable artifact, `ingressDriver`);
  and `CanvasLayout` (drag positions + viewport — visual only, never behaviour).
- **The compose source is the canonical anchor.** Redeploy re-parses the stored
  `composeSource`, so a hand-edit of the source is never overruled by stale model
  state. The model is a cache over compose, not a lock-in format.

## Deploy & release behaviour

- **Admission runs on every path.** Stack deploy, builder deploy, canary start,
  and rollback all call `evaluateAdmission` (guardrails · exposure · image
  policy). A `block` violation is refused unless an admin overrides; a `warn` any
  member can override; every override is audited. See `skill("hot-signal-design")`
  for how violations surface, and governance-and-access.md for the rules.
- **Full-fidelity deploy.** The builder's `deploy` projects the *entire*
  `ServiceModel` (placement, mounts, labels, healthcheck, resources, configs,
  secrets) through to the agent — unlike the lossy `services.create` subset. What
  you see on the canvas is what the agent applies.
- **Two-way, lossless compose.** Import preserves keys swarmy doesn't model
  (`build`, `depends_on` conditions, …) via passthrough and re-emits them on
  export; lossy normalisations (string `cpus:"0.5"` → number) are flagged, never
  silent. Round-trip is model-faithful and key-faithful, not byte-identical.
- **Releases are history + diff.** The Releases tab lists deploys (image ref,
  `+N services`, actor, status `deploying|healthy|rolled back|superseded`); opening
  one shows its image digests and a **compose diff** against the previous deploy,
  with one-click **Rollback** (redeploy that release's compose as a *new* release,
  audited).
- **Health-gated deploys.** Turn on a gate (watch window 30–3600s + optional
  auto-rollback) and the deploy-safety worker judges each new release against the
  stack's health narrative after the window: healthy → promoted; degraded/down →
  FAILED, and if auto-rollback is on, the last healthy release is redeployed. A
  gate never wedges forever — `unknown` health passes after 2× the window.
- **Canary, blue-green, rollback.** A canary deploys `<svc>--canary` (1 replica,
  no published ports) and stamps a weighted upstream onto the stable service's
  `swarmy.ingress.routes`; the deploy-canary worker promotes after a clean window
  or rolls back on an error-rate breach. Promote does a full-spec swap rebuilt from
  the live `service.inspect` so nothing is stripped; abort restores 100% stable,
  untouched.
- **Blueprints & previews.** Blueprints are a parameterised catalog (gallery →
  dry-run plan → sequential deploy through existing services). PR previews are
  ephemeral `pr<N>-<repo>` stacks (`swarmy.preview.*` labels) that the
  preview-reconcile worker tears down on merge/close — see cicd-and-registry.md.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Controller DB wiped mid-rollout | Release *history* is lost, but the gate/strategy/canary labels live on the stack's Docker objects — the workers keep judging and can still auto-rollback. The stack keeps running. |
| Health gate never gets health data | `unknown` health waits up to 2× the window, then passes (benefit of the doubt) — a gate must never wedge a release forever. |
| Canary's stable service disappears | `canaryStatus` skips it (nothing to compare or promote onto); no phantom rollout. |
| Deploy blocked by a guardrail | Refused before dispatch with a plain-words reason; an admin may override (member cannot, for `block`), and the override is on the record. |
| Imported compose uses non-Swarm keys (`build`, `network_mode`) | Import-and-warn: kept in passthrough, shown as lossy/info, not sent to the agent. Export re-emits them. Deploy still succeeds for the mapped surface. |
| Promote onto a live service | Full spec rebuilt from `service.inspect` before the image swap, so env/mounts/secrets/ports/placement are carried, never silently dropped. |

## Explicitly rejected

- **A swarmy-only manifest format.** The canonical model is a *superset of what
  compose and Swarm can both express*, and compose is always exportable. A
  proprietary format would trap config and break the unopinionated promise.
- **A generic JSON-Schema-to-form dump.** compose's `oneOf` unions and its ~40
  Swarm-meaningless keys make an auto-generated form surface fields that silently
  no-op. swarmy drives a curated field-descriptor registry instead (see the
  epic-stack-gui-builder plan).
- **Persisting live service/deployment state in the DB.** Replicas and convergence
  are read from Docker each time; a `Deployment` row would drift. Only swarmy's own
  *history* (`Release`) is stored — see the `docker-native-storage` skill.
- **Storing release policy in the DB.** Health gate, strategy, and canary are stack
  behaviour → they ride Docker labels so they survive a database loss. "Stored on
  the stack itself, so it survives anything."
- **Blocking deploy on autocomplete or health data.** Image search degrades to a
  free-text field when egress is blocked; a gate with no data passes rather than
  wedges. Convenience never gates the deploy.

## Implementation map

The end-to-end shape (model → agent → service → router → UI) is the
`add-feature-slice` skill; where release policy *lives* is the
`docker-native-storage` skill; the agent deploy dispatch is `agent-handlers`. Key
homes:

- **Canonical model + two-way compose**: `@swarmy/core/compose`
  (`composeToModels`, `modelsToCompose`, `modelToServiceSpec`, `validateModel`),
  driven by `packages/trpc/src/services/builder.service.ts` + `routers/builder.ts`.
- **Deploy + admission**: `packages/trpc/src/services/stack.service.ts`
  (`deployFromCompose`), `admission.service.ts` (+ `admission-guardrails`,
  `admission-exposure`, `admission-images`), `deployment.service.ts` (synthesised
  status).
- **Releases + canary**: `packages/trpc/src/services/releases.service.ts`
  (`recordRelease`, `rollbackTo`, `getSafety`/`setSafety`, `startCanary`/
  `promoteCanary`/`abortCanary`), `routers/releases.ts`, and the workers
  `apps/api/src/workers/{deploy-safety,deploy-canary,scale-to-zero}.ts`.
- **Blueprints, previews, HA templates**: `services/blueprints.service.ts` (+
  `blueprints/catalog.ts`), `services/previews.service.ts` +
  `workers/preview-reconcile.ts`, `services/templates.ts` (region-aware HA compose
  that stores its own portable source).
- **Data model**: `packages/db/prisma/schema/releases.prisma` (`Release`) and
  `schema/cluster.prisma` (`Stack`, `CanvasLayout`).
- **UI**: `apps/app/src/components/canvas/*` (service canvas, inspector, toolbar,
  layout), `components/service-builder/*`, `components/releases/*` (releases feed,
  canary panel, release detail), `components/blueprints/*`, `components/ci/previews-*`,
  and routes `apps/app/src/routes/_authed/stacks/$name.{index,releases}.tsx` +
  `services/builder.tsx`.
