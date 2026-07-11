---
name: reconcile-workers
description: Invariants, contracts, and file map for swarmy's controller-side reconcile workers — the periodic loops in apps/api/src/workers/* that read live Docker/hub truth, compute a desired signature, and dispatch agent commands to converge. Load before adding or touching any *-reconcile / scheduler worker, or wiring one into workers/index.ts. dns-reconcile.ts is the reference; manageddb-reconcile is the managed-service reference. This skill is the worker-pattern authority — the `docker-native-storage` and `agent-handlers` skills point here for the "then a worker converges it" step.
---

# Reconcile workers: compose → signature → push → converge

This skill is the HOW for the controller's convergence loops. A reconcile
worker is a periodic `setInterval` that, per org, reads live Docker truth from
the hub, computes what SHOULD be true, and dispatches agent commands to close
the gap — idempotently, so a steady state does nothing. It is the "step 3" that
`skill("docker-native-storage")` and `skill("agent-handlers")` both defer to:
labels/specs describe desired behaviour, agent handlers apply a single command,
and a worker is what continuously drives Docker toward the labels.

## Invariants (violating any of these is a bug, not a style choice)

1. **The worker is a SCHEDULER; the reconcile LOGIC is pure and imported.**
   Signature computation, spec building, and diff planning live in `packages/*`
   (exported from `@swarmy/trpc` root) or in a co-located, unit-tested
   `*-reconcile.core.ts`. The worker file only ticks, loops orgs, and calls it.
   Inlining a divergent copy of a renderer/diff into a worker is THE historical
   bug (the v1 `geodns-reconcile` inlined the zone renderer and drifted); every
   worker header now names this constraint. See `dns-reconcile.ts` (imports
   `reconcileDnsOrg`) and `manageddb-reconcile.ts` (imports its `.core.ts`).
2. **Pushes are SIGNATURE-GATED and idempotent.** Compute a deterministic
   signature of the desired state, hold `lastSignature` in a per-org `Map`, and
   skip the dispatch when it is unchanged. A tick at steady state must send
   ZERO commands. The signature form varies by worker
   (`reconcileDnsOrg`'s `push.signature`, `siblingSetSignature` for region
   siblings, the `swarmy.cache.appliedMemoryMb` applied-stamp for caches) but
   the gate is universal.
3. **Docker is the source of truth; read the hub, never the DB, for swarm
   state.** Desired state comes off `hub.liveInventory(orgId)` (service labels /
   specs) and mutations go out via `hub.dispatch(managerNode, cmd, payload)`.
   Never read swarm inventory back from Postgres — it is stale the instant
   Docker changes (`skill("docker-native-storage")`).
4. **Org-scoped, and one org's failure never kills the tick.** Iterate the org
   set, wrap each org's body in try/catch (or `.catch(() => undefined)` on every
   dispatch), and continue. Two org-source patterns, pick by whether the feature
   is DB-gated: `new Set(store.nodeOrg.values())` (Docker-truth: only orgs with a
   connected node — scale-to-zero, region, cache) vs.
   `prisma.<config>.findMany({ where: { enabled: true } })` when a DB flag gates
   the feature (dns via `geoDnsConfig`, ingress via `organization`).
5. **Ticks do not overlap, and the loop is drained on stop.** Long pushes can
   outrun the interval, so guard with a `running` flag that skips a re-entrant
   tick (`dns-reconcile`). `start<Name>()` returns a stop fn that clears the
   interval (and any deferred kickoff). This is the shape `workers/index.ts`
   composes.
6. **System-actor mutations still write audit + alerts.** A worker that fires an
   alert, records an incident, or performs a remediating deploy binds one org's
   `systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId)` and
   goes through `fireEvent` / `recordIncidentEvent` / `writeAudit` — so an
   automated action lands on the same audit trail as a human one, attributed to
   the `system` actor (`manageddb-reconcile`, `cache-reconcile`, `alert-evaluator`).
7. **Registered EXACTLY ONCE in `workers/index.ts`.** A new worker exports
   `start<Name>(): () => void` and is added to the `stops` array in
   `startWorkers()`. Unregistered = dead; registered twice = double dispatch.
8. **Defer the first run when the tick needs a warm hub.** Nodes reconnect a few
   seconds after boot; a worker that dispatches on t=0 fans out to zero managers.
   Defer the kickoff (`ingress-reconcile` waits 30s) or skip the first
   signature observation so startup doesn't count as a change (`region-reconcile`).

## Contracts between the layers

- **Worker → pure core**: the reconcile fn takes `{ db, hub, orgId,
  lastSignature?, converge? }` and returns a skip-aware result the worker gates
  on — e.g. `reconcileDnsOrg(...)` → `{ push: { skipped, signature, zones,
  pushed, failed }, providerSynced? }`. The worker stores `signature` only when
  `!skipped`. Cheap push every tick; expensive full re-converge (spec drift, new
  service creation) every N ticks behind a `converge: tick % CONVERGE_EVERY === 1`
  flag (`dns-reconcile` re-converges the swarmy-dns global service ~every 5 min).
- **Worker → hub**: `hub.liveInventory(orgId)` for desired state,
  `hub.managerNode(orgId)` for a write target (a connected swarm manager; may be
  `undefined` → skip the org this tick), `hub.dispatch(nodeId, '<CommandName>',
  payload)` to converge. The `CommandName` and its wire type are the ones the
  agent executor handles (`skill("agent-handlers")`); a worker never hand-rolls a
  wire frame.
- **Worker → audit/alerts**: `systemContext(deps, orgId)` then the org-scoped
  `fireEvent` / `recordIncidentEvent` / `writeAudit` seams re-exported from
  `@swarmy/trpc`.
- **Registration**: `startWorkers()` calls every `start<Name>()`, collects the
  returned stop fns, and returns a single teardown that runs them all.

## File map

| Concern | Where |
|---|---|
| Central registration (`startWorkers` + stop fns) | `apps/api/src/workers/index.ts` |
| Reference worker (compose→signature→push, org-from-DB, converge cadence) | `apps/api/src/workers/dns-reconcile.ts` |
| Managed-service reference (pure `.core.ts` + system-actor audit/alerts) | `apps/api/src/workers/manageddb-reconcile.ts` + `manageddb-reconcile.core.ts` |
| Docker-truth loop, org-from-`store.nodeOrg`, no DB | `apps/api/src/workers/scale-to-zero.ts` |
| Materialise siblings + signature-gated ingress re-render | `apps/api/src/workers/region-reconcile.ts` |
| Diff/render in trpc, worker holds only the per-org last-set | `apps/api/src/workers/ingress-reconcile.ts` |
| Data-plane converge + `INFO`-stat stamping + alerts | `apps/api/src/workers/{cache,search,vector,queue}-reconcile.ts` |
| Simplest shape (pure DB scheduler, no hub) | `apps/api/src/workers/retention.ts` |
| Hub surface (`liveInventory`/`managerNode`/`dispatch`) | `packages/trpc/src/hub/types.ts` (impl `apps/api/src/gateway/index.ts`) |
| Per-org org set (`store.nodeOrg`) | `apps/api/src/gateway/store.ts` |
| Reconcile-logic homes (imported, not inlined) | `@swarmy/trpc` (`reconcileDnsOrg`, `reconcileColdIngress`, `reapplyIngressForOrg`, `siblingSetSignature`) + co-located `*-reconcile.core.ts` |
| System-actor seams | `@swarmy/trpc` (`systemContext`, `fireEvent`, `recordIncidentEvent`, `writeAudit`) |

## Adding a reconcile worker (the recipe)

1. **Put the logic in a pure module** first: export a signature/spec/diff fn from
   the owning `*.service.ts` via the `@swarmy/trpc` root, OR write a co-located
   `apps/api/src/workers/<name>-reconcile.core.ts` with a unit test. It must be
   deterministic and take data in, commands-to-send out — no `setInterval`, no
   direct socket.
2. **Write the scheduler** `apps/api/src/workers/<name>-reconcile.ts` exporting
   `start<Name>(): () => void`: choose the org source (invariant #4), hold a
   `lastSignature`/last-set `Map`, guard overlap with a `running` flag, wrap each
   org, `.catch(() => undefined)` every dispatch, and return the interval
   teardown. Defer the first run if it needs a warm hub.
3. **Converge via the hub**: `hub.dispatch(hub.managerNode(orgId)!, '<CommandName>',
   payload)` — the command must already exist in the executor
   (`skill("agent-handlers")`); if it doesn't, add it there first.
4. **Audit side-effects**: if the tick fires alerts / incidents / remediating
   deploys, bind `systemContext(deps, orgId)` and go through the shared seams —
   don't write the DB directly.
5. **Register once** in `apps/api/src/workers/index.ts`: import `start<Name>` and
   add it to the `stops` array in `startWorkers()`.
6. **Verify**: `bun --filter @swarmy/api typecheck` and the reconcile core's unit
   test (`bun --filter @swarmy/api test <name>-reconcile`). Steady-state check:
   with no label changes a second tick must dispatch nothing (assert the
   signature gate). Multi-node behaviour on the `scripts/local-vms.sh` swarm
   (`skill("run-local")`): change a `swarmy.*` label, watch one tick converge and
   the next tick go quiet.

## Operational gotchas

- **Cadence**: 10s for latency-sensitive loops (scale-to-zero, cold ingress),
  15–30s for compose/topology converge (dns, region, managed data). A tick's
  work must comfortably finish inside its interval — that is why #5 exists.
- **`managerNode` can be `undefined`** during controller startup or a full
  manager outage — treat it as "skip this org this tick," never throw.
- **A worker cannot subpath-import an internal trpc module** — that is the whole
  reason a co-located `*-reconcile.core.ts` exists next to some workers. If you
  copy label constants, source them from `@swarmy/core` so the inventory and the
  worker agree (region/cache do this); do not fork the diff logic.
- **DNS/edge convergence is its own worker** (`dns-reconcile`, region-aware
  ingress re-render) — see `skill("geo-edge-routing")` for the snapshot/health
  contracts a reconcile push must respect; this skill owns only the loop shape.
