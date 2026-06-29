---
name: docker-native-storage
description: Decide WHERE a piece of swarmy config/state lives — Docker labels (service/container), stack-level labels, Docker configs, Docker secrets, or Postgres. Use whenever adding a feature that needs to persist "how a service/stack/node should behave", or when you catch yourself reaching for a new Prisma model/column for swarm state. swarmy's rule: Docker is the source of truth; the DB is only swarmy's own identity, access control, audit, and queryable history.
---

# Docker-native storage: where does this belong?

swarmy ripped container/swarm STATE out of Postgres (epic #6). The standing rule for
any new config or state:

> If it describes **how a service / stack / node should behave**, store it ON the
> Docker object (label / config / secret) — not in swarmy's DB. The swarm becomes
> self-describing: swarmy can rebuild its whole view from an empty database.

Before adding a Prisma model or column, run the decision below.

## Decision order (pick the FIRST that fits)

1. **Sensitive value injected into a deployed app** (DB password, app API key, TLS
   key) → **Docker secret** (`docker secret create`, mounted at `/run/secrets/*`).
   Never a label or env. swarmy's OWN auth secrets are the exception — see "Stays in
   the DB".

2. **Small declarative per-service behaviour** (routing, scaling, placement, layout,
   backup/observability/mesh opt-in, region weights) → **service label**, namespaced
   `swarmy.<area>.<key>`. Stamp via the `service.updateLabels` dispatch; read from the
   live inventory (`ctx.hub.liveInventory` → `buildInventory`, or
   `SwarmServiceInfo.labels` directly). Examples already in the tree:
   `swarmy.scaleToZero.*`, `swarmy.region.<region>.replicas`, `swarmy.db.*`,
   `swarmy.canvas.x/y`, `com.docker.stack.namespace`.

3. **Stack-level config** (applies to a whole project, not one service) → put it at
   the **stack level**. Two good homes:
   - a label on every service in the stack carrying `com.docker.stack.namespace=<stack>`
     (e.g. `swarmy.stack.<key>` stamped on the stack's services), or
   - a thin DB row keyed by stack name when it is genuinely the user's INPUT artifact
     (e.g. `Stack.composeSource`) rather than derived swarm state.
   Derive the stack's LIVE status/membership from the namespace label via
   `buildInventory` — never persist it.

4. **Larger config blob the swarm should distribute** (compose source, a rendered
   Caddyfile / proxy config, a dashboard json) → **Docker config** (`docker config
   create`, swarm-replicated + versioned), referenced from the service spec. Rotate by
   creating a new config and updating the service (configs are immutable).

5. **Network-scoped metadata** → **network label**.

6. Otherwise → it may legitimately belong in Postgres (see below).

## Stays in the DB (do NOT move these to Docker)

- **swarmy's own identity / auth**: sessions, API keys, OAuth client secrets, webhook
  signing secrets, the per-node reconnect credential (`Node.sessionSecretHash`).
- **Access control + audit**: RBAC policies + ResourceGrants, the AuditLog — they need
  querying, history, and must not be world-readable.
- **Queryable history / time-series**: MetricSample (wants a DB/TSDB), build history.
- **Durable queues**: webhook delivery outbox.
- **Relational core**: Org / Member / Invitation.

Rule of thumb: labels are **string-only, size-limited (~few KB), and visible to anyone
who can `docker inspect`**, with no query or history. Perfect for declarative state;
wrong for secrets, audit, history, and anything you need to query across.

## How to implement a label-backed setting (the pattern)

1. **Write**: a tRPC `orgProcedure` resolves the service (`liveService(ctx, idOrName)`
   in `service.service.ts`), `resolveManagerNode(ctx)`, then
   `ctx.hub.dispatch(node.id, 'service.updateLabels', { service, add: { 'swarmy.<area>.<key>': value }, removeKeys: [] })`.
   Values are strings; encode structured data as JSON in ONE label
   (e.g. `swarmy.ingress.routes='[{...}]'`) rather than many fragile keys.
2. **Read**: never hit the DB. Read from `ctx.hub.liveInventory(orgId)` /
   `buildInventory` and pull the label off `InvService.labels` / `SwarmServiceInfo.labels`.
   For "list across the org", scan the inventory.
3. **Reconcile** (if it drives real swarm changes): a worker in `apps/api/src/workers/*`
   reads the labels from the live inventory each tick and converges Docker to match
   (see `scale-to-zero`, `region-reconcile`, `manageddb-reconcile`). Registered in
   `workers/index.ts`.
4. **Migrate off a model**: stop writing the DB row, point all readers at the inventory
   labels, then drop the model from `schema.prisma` and `prisma db push`. Convert any
   FK that referenced it to a plain string column. Verify: typecheck + the live read
   path returns from the hub.

## Anti-patterns

- Adding a Prisma model for "service X's setting" → use a service label.
- Reading swarm state back from the DB (it's stale the moment Docker changes) → read
  the live inventory.
- Stuffing a secret into a label or env → Docker secret.
- A label per array element (`swarmy.ingress.0.host`, `.1.host`) → one JSON label.
