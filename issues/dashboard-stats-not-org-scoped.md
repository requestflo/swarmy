# Dashboard "nodes online" / "services running" stats leak raw Docker Swarm state across org boundaries

**Status:** Open — not fixed. Confirmed via live reproduction 2026-07-10, not a security/tenant-isolation
issue (no cross-org data is exposed to the *user*, the numbers are just wrong), but it will
mislead operators and should be fixed before relying on the Infrastructure overview page.

## Symptom

With exactly one node (`lima-swarmy-node-1`) freshly enrolled to a brand-new org, the
Infrastructure page's "NODES ONLINE" stat card and the sidebar indicator both read **2/2**,
while the "Cluster nodes" table directly below correctly listed only 1 node. Separately, after
reforming the swarm, the "SERVICES RUNNING" stat showed `1/2` / `1 containers` for an org that
had deployed nothing — the count came from `blog-db`/`blog-wordpress` services left over in the
underlying Docker Swarm from a completely different org's earlier test deploy.

## Root cause (confirmed via code read)

The live inventory pipeline conflates **raw Docker Swarm membership** with **swarmy's per-org
DB enrollment**:

1. `apps/agent/src/snapshots.ts` (`sendNodeList()`) runs `docker.listNodes()` on the manager
   agent and forwards the *entire* `docker node ls` payload verbatim — Docker has no concept of
   swarmy orgs, so this includes every swarm member regardless of which (if any) org they're
   enrolled to.
2. `apps/api/src/gateway/protocol-handlers.ts`'s `nodeList` handler stores that payload
   unfiltered, keyed by the *controller* node id that sent it.
3. `apps/api/src/gateway/store.ts` (`nodeInventoryForOrg`) correctly enumerates which
   *controller* nodes belong to the requesting org, but then attaches that manager's **entire**
   raw `docker node ls` snapshot to the result — including swarm members that were never
   enrolled to this org's DB at all.
4. `packages/trpc/src/services/metrics.service.ts` (`getOverview` / `getDashboardSummary`)
   consumes this unfiltered inventory to produce `nodes.online/total`, surfaced by
   `ClusterHero` (`apps/app/src/components/infra/cluster-hero.tsx`) and the sidebar
   (`apps/app/src/components/shell/sidenav.tsx`).

The DB-backed `nodes.list` query (`apps/app/src/routes/_authed/nodes/index.tsx`, `Node` table
filtered by org) is correctly scoped — only the summary/overview stats are wrong.

The same conflation applies to services: `docker service ls` on the manager returns every
service in the swarm, not just the ones swarmy's DB knows this org deployed.

## Why this matters

Any Docker Swarm member that isn't cleanly removed from the swarm when a node is deleted from
swarmy's DB (e.g. `docker node rm` never ran, or a node was manually joined outside swarmy)
will silently inflate another org's "nodes online" / "services running" counts on the *same
physical swarm*. In production this shouldn't normally arise (each org's swarm is meant to be
physically separate), but it's a foot-gun for shared-swarm test/dev setups and for any future
"detach a node" flow that doesn't also `docker node rm`/`docker service rm` the underlying
Docker state.

## Suggested fix

In `nodeInventoryForOrg` (`apps/api/src/gateway/store.ts`), filter the manager's raw
`swarmNodes`/`swarmServices` snapshot down to entries that correspond to Node/Stack rows
actually enrolled to the requesting org — or explicitly surface unenrolled swarm members as a
distinct "orphaned/foreign" state rather than silently folding them into the org's own counts.
