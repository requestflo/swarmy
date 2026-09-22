# Ingress is unreachable out of the box, through every driver, at every stage — dashboard status badges never reflect this

**Status:** Fixed in code — pending live re-verification (see "Fix applied (2026-09)" below).
**Severity:** Critical — this is the literal "start small: ingress + one browser-reachable app" bar the
governing directive named as the first real deployment milestone, and it fails at every layer, with the
dashboard actively misreporting success the whole way through.
**Verified current as of 2026-07-11 against HEAD `ccd2ae4`** — the codebase moved substantially during
this investigation (15+ intervening commits touching ingress directly, including a new geo-edge
topology — see "Update" section below). Every file:line citation in this writeup was re-checked against
that HEAD and still matches.

## Symptom

Deployed the "Static site" blueprint (`littleworld`, nginx, domain
`littleworld.192.168.5.15.nip.io`) through the real Deploy → Blueprints → Preview plan → Deploy flow.
Zero code changes, zero manual SSH steps. Stack converges: "All green.", 1/1 replicas.

The stack's **Network tab** immediately shows the route as fully live:

> Domains & routes — **1 / 1 SECURED**
> `littleworld.192.168.5.15.nip.io` · `LITTLEWORLD-SITE · :80` · ● green dot · **TLS auto**

This reads as "done — your site is live and HTTPS-secured." It is not. In every configuration tried
(see below), the site was **completely unreachable**:

- `docker service ls` / `docker ps -a` / `docker network ls` on the node: no reverse-proxy/ingress
  service of any kind exists — only the app's own container.
- Direct `curl` from inside the VM itself against `127.0.0.1:80` and `127.0.0.1:443` with the right
  `Host` header: connection refused (`http_code=000`, exit 7) on both.
- An SSH-forwarded port from the Mac (the same network path a real browser would take) to the VM's
  80/443: `Recv failure: Connection reset by peer` (HTTP) and `SSL_ERROR_SYSCALL` (HTTPS).
- An actual Chrome browser navigation to the routed hostname (via the port-forward): the browser
  itself renders a connection-error interstitial — couldn't even be screenshotted by the browser
  automation tooling because it's a native Chrome network-error page, not application content.

Three independent methods (raw docker inspection, curl through a real network path, and an actual
browser load) all agree: **nothing is listening**, despite the dashboard's unambiguous "1/1 SECURED" /
"TLS auto" claim.

## Root cause #1: the status badge is derived from stored config, not runtime truth

Per source: `live = enabled && driver !== 'none'` in the ingress route (`apps/app/src/routes/_authed/ingress.tsx:68-71`),
and the per-stack route's "TLS auto"/"SECURED" badge is likewise rendered purely from what's saved in the
`ingressConfig`/route DB rows — never from whether the actual proxy container is up, listening, or has
successfully obtained a certificate. The UI has no mechanism to represent "configured but not actually
serving" — it only knows "configured" and renders that as if it were "serving."

## Root cause #2: selecting + enabling a driver silently does nothing

Platform → Edge & ingress defaults to **"None (self-managed)"** for every new org — explicitly
"tracking only," the page says "swarmy tracks domains for display but writes no routing config to your
nodes." This alone means a brand-new org's very first route is never functional unless the operator
finds and changes this setting — a step nowhere mentioned in onboarding, the blueprint deploy flow, or
the stack's own Network tab.

Switching the driver to **Traefik** and toggling "Enabled" (the obvious, primary control on the page)
changes the top-right status badge to "Traefik · live" and shows a plausible rendered-config preview.
**Nothing is deployed to the node.** (Traefik's mode is documented as "bring your own" — the driver
correctly writes routing *labels* onto the app's own Swarm service spec — `traefik.enable=true`,
`traefik.http.routers...` — for an operator's pre-existing Traefik instance to pick up. That part works
as designed. But there is no operator-run Traefik anywhere in this environment, so the labels have
nothing to attach to.)

Switching to **Caddy** — the option explicitly labeled "Automatic HTTPS. **Recommended.**" — is the one
a new user would reasonably pick for a magical, zero-config experience. Toggling "Enabled" here *also*
silently deploys nothing. Per source (`packages/trpc/src/services/ingress.service.ts` — `setDriver`
line 576-595, `setEnabled` line 729-734, both funnel through the private `reapply()` at line 852-860):
`reapply()` renders a Caddyfile and POSTs it to the (not-yet-existing) `swarmy-ingress-caddy` controller's
admin API — and wraps the whole attempt in a bare `try { ... } catch { return null; }`. The POST fails
(DNS/connection error, since the controller was never created), the error is silently swallowed, and
**nothing surfaces to the user** — no toast, no failed-status badge, nothing. The primary "select
driver → enable" flow that any user would follow gives zero indication anything is wrong.

## Root cause #3: the actual deploy step exists, but is a disconnected, undiscoverable second control

The real controller-deployment code (`ensureCaddyController`, `packages/trpc/src/services/ingress-controller.ts:156`)
is fully built and works — it's wired to a **separate** tRPC mutation, `ingress.ensureController`, exposed
only via a "Deploy / converge controller" button inside a card titled **"Controller image"**, positioned
below an "On-demand TLS" card and above a "Target nodes" card — well below the fold, several scrolls past
the primary Driver/Enabled controls, with no visual link connecting it to the driver selector above. There
is also a separate, off-by-default **"Target nodes"** toggle list a user must find and turn on for at
least one node before the controller has anywhere to schedule.

None of this — not the driver dropdown, not the Enabled toggle, not the blueprint deploy flow, not the
stack Network tab — tells the user these two additional steps exist. A user following only the visible
"pick a driver, flip Enabled" flow (which the page's own copy presents as complete: "Driver, TLS, HA
storage and the controller build — fleet-wide") ends up with a permanently non-functional route and a
dashboard confidently telling them otherwise.

## Root cause #4: even after finding and completing every step, the controller can never schedule — a deterministic placement bug

Having found and used the buried "Target nodes" toggle + "Deploy / converge controller" button (toggled
the sole node `lima-swarmy-fresh-1` on, clicked deploy), a `swarmy-ingress-caddy` service *is* finally
created — but with **0/1 replicas, permanently**:

```
$ docker service ps swarmy-ingress-caddy
ID          NAME                     ...  DESIRED STATE   CURRENT STATE            ERROR
dcbl3f...   swarmy-ingress-caddy.1   ...  Running         Pending 22 seconds ago   "no suitable node (scheduling constraints not satisfied on 1 node)"
```

The service's placement constraint:

```
$ docker service inspect swarmy-ingress-caddy --format '{{json .Spec.TaskTemplate.Placement}}'
{"Constraints":["node.id==cmrfodzd9001i4vsb0pafd656"]}
```

`cmrfodzd9001i4vsb0pafd656` is **swarmy's own internal database node ID** (a cuid-style primary key from
its `Node` table) — not a Docker Swarm node ID. The real Docker Swarm node ID for that same box is a
completely different value:

```
$ docker node ls
ID                            HOSTNAME              STATUS   ...
zz40tjnscsjyi8ixql4zxcs5q *   lima-swarmy-fresh-1   Ready    ...
```

Source: `ingressPlacementConstraint()` in `packages/trpc/src/services/ingress-controller.ts:92-98`:

```js
function ingressPlacementConstraint(ctx: OrgContext, targetNodes: string[] = []): string {
  if (targetNodes.length === 1) return `node.id==${targetNodes[0]}`;
  ...
}
```

`targetNodes` is populated directly from whatever ID the "Target nodes" UI toggle sends via the
`ingress.setTargetNodes` mutation (`packages/trpc/src/services/ingress.service.ts:562-568`,
`nodeIds` param stored verbatim) — there is no translation step anywhere between swarmy's own node
identity and Docker's. Docker's engine has never heard of `cmrfodzd9001i4vsb0pafd656` and never will, so
this constraint is **unsatisfiable by construction, on every node, in every org, forever**. This isn't
an edge case or a race — it's a guaranteed, 100%-reproducible dead end the moment exactly one node is
pinned as the ingress target, which is the only way the button is discoverable to actually try (the
"mark several as the edge tier" alternative uses a Docker node *label* constraint instead, which would
plausibly work — untested this session — but a single-node swarm following the obvious "pin this one
box" UI path hits the broken single-node case every time).

**Confirmed with file:line precision.** The toggle itself lives in
`apps/app/src/components/ingress/target-nodes-card.tsx:41` —
`setTargetNodes.mutate({ nodeIds: next })`, where `next` is built from `n.id` (lines 39-40, 67),
sourced straight from `trpc.nodes.list`. That `id` is swarmy's own internal DB `Node.id`
(`id String @id @default(cuid())`, `packages/db/prisma/schema/cluster.prisma:17`) returned verbatim by
`listNodes`/`toSummary` (`packages/trpc/src/services/node.service.ts:94-108`) — never a Docker Swarm ID.

Critically, **the correct fix already exists elsewhere in the codebase and just isn't called here**:
`Node` deliberately has no persisted `dockerNodeId`/`swarmNodeId` column — instead the real Docker
Swarm ID is resolved live via `ctx.hub.swarmNodeIdFor(id)`, and other code paths already use it
correctly (e.g. `dispatchNodeLabels`, see `node.service.ts:152, 171, 387`) to translate a swarmy DB id
into a real swarm node id before dispatching anything to Docker. `ingressPlacementConstraint()` simply
never calls `swarmNodeIdFor()` — the fix is a one-line call to an existing, already-proven helper, not
new plumbing.

## Why this matters for the "magical install" bar

This is the exact feature the governing directive named as the first thing to prove out — "start off
really small, like, with potentially just ingress with a little world, and we can get to it using a
browser." It fails at four independent, stacked layers: a misleading always-green status badge, a
default mode that does nothing, a "recommended" mode whose failure is silently swallowed, and — even
for the one determined operator who finds and completes every hidden step — a guaranteed-broken Docker
placement constraint using the wrong ID namespace. A real user has no path to a working route today
without reading source code, which is the opposite of "magical."

## Suggested fix direction

- **Wire up the already-built `edge-per-node` topology (see "Update" section below) — likely the
  fastest path to an actually-working route.** `ingress.setTopology` is fully implemented and, by
  design, avoids the node-ID bug entirely (global mode + label constraint). Adding a UI control for it
  may be less work than auditing/fixing the legacy `controller` topology's placement code, and gives
  users a topology that's more production-appropriate anyway (per-node edge Caddy, no routing-mesh
  rebalancing surprises).
- **Placement constraint bug (highest priority, small fix, if keeping the `controller` topology):** `ingressPlacementConstraint()`
  (`packages/trpc/src/services/ingress-controller.ts:93`) must resolve `targetNodes[0]` through
  `ctx.hub.swarmNodeIdFor(id)` — the same helper `dispatchNodeLabels` already uses
  (`packages/trpc/src/services/node.service.ts:152, 171, 387`) — before building the `node.id==`
  constraint, instead of using the raw swarmy DB id verbatim. This is a one-line call to an existing,
  already-proven helper, not new plumbing, and it alone is why the ingress controller can never run
  even once an operator finds and completes every other hidden step correctly.
- Make `reapply()`'s failure path (`ingress.service.ts:852-860`) surface real errors to the dashboard
  (toast + a "degraded"/"failed" state on the route badge) instead of a bare `catch { return null }`.
- Derive the per-route "SECURED"/"TLS auto" badge from actual controller/certificate state (e.g. does
  `swarmy-ingress-caddy` exist and have >=1 running replica, has a cert been issued) rather than from
  saved config alone. A route that's merely *configured* should read differently from one that's
  *serving*.
- Fold "Deploy / converge controller" and "Target nodes" into the primary driver-select/Enabled flow —
  e.g. auto-deploy the controller and auto-pin it to the sole/first manager node when a driver is
  enabled on a swarm with no ingress node marked yet, rather than requiring a user to scroll past two
  unrelated cards to find them.
- Consider changing the new-org default away from silent "None (self-managed)" tracking-only mode, or
  at minimum making the Network tab's route status visibly distinguish "tracked only, nothing will
  route" from "actually live."

## Update: a working-by-design fix already exists in source but has zero UI wiring

While re-verifying this writeup against the current HEAD, found that `packages/trpc/src/services/ingress-controller.ts:216-364`
now contains a second, newer deployment path: `ensureCaddyEdge()` / the `'edge-per-node'` topology
(geo-edge). It deploys the edge Caddy as a Docker Swarm **global service** (`mode: { global: {} }`,
`caddyEdgeSpec()` line 265) constrained by `node.labels.swarmy.node.ingress == true` (line 295) — a
label-based constraint, not `node.id==`. This **completely sidesteps root cause #4 above**: global mode
with a label constraint schedules correctly on every labeled node regardless of swarmy's internal DB
node IDs, with no ID-translation problem to hit in the first place. It's reachable via a real tRPC
mutation, `ingress.setTopology` (`packages/trpc/src/routers/ingress.ts:75-82`,
`z.enum(['controller', 'edge-per-node'])`), which is fully implemented, including a documented legacy
cutover path that removes the old replicated controller first.

**This mutation is not called from anywhere in the dashboard.** `grep -rn "setTopology|edge-per-node|ensureCaddyEdge" apps/app/src/`
returns zero real matches (one unrelated false-positive hit in a database-topology-selector component).
There is no topology switch, toggle, or any other control anywhere in the Platform → Edge & ingress page
or its child components that would let a user reach this code path. It is fully built, and by its own
design looks like it should avoid the exact scheduling bug documented above — but it is completely
unreachable through the product, so it changes nothing about this issue's verdict (ingress is not
achievable through the product surface today). It does, however, materially change the recommended fix:
wiring `setTopology('edge-per-node')` into the dashboard alongside (or instead of) fixing
`ingressPlacementConstraint()`'s `swarmNodeIdFor()` call may be the faster, already-tested-by-construction
path to a working single-node ingress route, since the hard scheduling problem for that topology has
apparently already been solved in code that simply was never connected to a button. This is the same
"real fix already exists, orphaned from the UI" pattern found in
[[install-defaults-to-unpullable-ghcr-image]] for the installer — worth checking whether that's a
recurring team habit (build the backend, ship it, and never circle back to wire the UI) worth calling
out at the process level, not just per-bug.

Not tested live this session — deliberately did not call `ingress.setTopology` directly via a raw API
request to work around the missing UI button, since that would be exactly the kind of manual,
off-product-surface intervention the standing testing methodology rules out. If/when this gets wired to
a UI control, it should be retested end-to-end the same way the `controller` topology was here.

## Not yet tested

- Whether the "mark several as the edge tier" (`swarmy.node.ingress` label-based) placement path avoids
  the node-ID bug above — plausible since it uses `node.labels.*` rather than `node.id==`, but not
  exercised this session.
- Multi-node target selection.
- Cloudflare Tunnel, nginx, and HAProxy drivers — untested this session; Traefik and Caddy were the two
  exercised.
- Whether a route ever actually reaches "SECURED" for real (cert issuance, HTTPS termination) once the
  placement bug above is fixed — blocked on that fix.

## Related, separately-observed anomaly (investigated, inconclusive — not this issue's focus)

While testing this, the browser dashboard session died unexpectedly multiple times in short succession
(tRPC calls started returning 401, page redirected to `/login` on next navigation) during otherwise
normal, continuous interactive use — no idle period, actively clicking through the ingress page.

A source-level check of the session implementation found nothing that would explain a multi-minute
death cadence: sessions are DB-backed via Better Auth + Prisma (`packages/auth/src/server.ts:119-157`,
`packages/db/prisma/schema/auth.prisma:23-38`), not in-memory; no `expiresIn`/`updateAge` override
exists anywhere in the repo, so Better Auth's defaults apply (7-day session, 1-day sliding refresh); the
only non-default knob is a 60s *signed-cookie read cache* (`cookieCache.maxAge`, `server.ts:154`), which
transparently re-validates against the DB on expiry rather than logging anyone out. With the default
Postgres driver, sessions survive API restarts (an embedded `pglite` "lite mode" exists and would wipe
sessions on every process restart, but that's an opt-in local-dev mode, not the default).

**Net: this doesn't look like a real product bug from source alone** — the configured numbers don't add
up to "dies every few minutes." Likely candidates, none confirmed: a non-default local `.env` (e.g. a
placeholder `BETTER_AUTH_SECRET` or `SWARMY_DB_DRIVER=pglite` set in this specific dev environment,
both flagged as known local-dev traps in `docs/LOCAL-SWARM.md:242`), or dev-server hot-reload
disrupting the running process. Not root-caused to a specific trigger this session, and not written up
as its own `issues/*.md` entry — logging it here since it repeatedly disrupted this session's testing,
but treating it as an environment artifact rather than a confirmed production defect unless it
reproduces against a real, non-dev deployment.

## Fix applied (2026-09)

Code-only; not yet re-run against a live swarm. Summary per root cause:

- **#4 placement (wrong node-id namespace).** `ingressPlacementConstraint()` is now a pure function
  (`packages/trpc/src/services/ingress-controller.ts:115`) that resolves the pinned swarmy enrollment id
  through `hub.swarmNodeIdFor()` (same bridge `dispatchNodeLabels` uses) and emits
  `node.id==<docker swarm node id>`. A legacy pin that is already a swarm id is accepted; an
  unresolvable pin falls back to the `swarmy.node.ingress` label / manager constraint instead of an
  unsatisfiable one. Golden-tested, including through `ensureCaddyController`'s dispatched spec.
- **Hidden #5 found while fixing: routes never reached the controller even when it ran.** The
  controller topology defaulted to `applyVia: 'file'`: the agent wrote the Caddyfile on its OWN host
  and ran `caddy reload` there, where no Caddy exists. New default `applyVia: 'exec'`: the controller
  dispatches only to the node(s) running a `swarmy-ingress-caddy` task (Docker truth off container
  snapshots), and that agent writes the Caddyfile INTO the task and execs `caddy reload` there
  (`RenderedConfig.localReload.file`, agent `writeFileExec`). No overlay membership, published admin
  API, or host bind mount needed. Zero running tasks is now an apply error, never "applied to 0
  node(s)". Operator `extraConfig.applyVia` overrides still win. The agent's admin-API path also no
  longer swallows a failed POST.
- **Controller spec.** 80/443 now publish in host mode (routing mesh is unreachable in some envs — see
  `swarm-routing-mesh-unreachable-in-lima-vm` — and host mode keeps client IPs); the unauthenticated
  admin API is no longer published by default; `--resume` keeps the last config across task restarts.
- **#2/#3 enable does nothing / deploy step hidden.** `setDriver`, `setEnabled`, `setTargetNodes`,
  and `setControllerImage` now converge the controller themselves (`convergeEdge`) when the driver is
  Caddy and enabled, then re-apply. `reapply()` no longer has a bare `catch { return null }`; every
  apply/converge outcome is recorded and read back through `runtime` (and toasted when down/degraded).
- **Reconcile.** `ingress-reconcile` now runs `reconcileIngressOrg` (signature-gated over the full
  resolved config + running Caddy task container ids): routes written straight onto service labels by
  a blueprint deploy get applied, a freshly scheduled task gets its config the tick it appears, and a
  missing controller is re-deployed (rate-limited to once a minute).
- **#1 status badges.** `IngressConfigView.runtime` (`deriveEdgeRuntime`) and per-route
  `DomainView.serving`/`edgeState` come from live Docker state plus the last apply outcome:
  `tracking | paused | unverified | down | deploying | degraded | serving`. The Edge & ingress header,
  the "All domains" list, and the stack Network tab ("N / M secured", TLS badge) only show green or
  "secured" when the route is actually being served. Otherwise they show "not routed" / "edge down" /
  etc., with an explanatory alert on the Edge & ingress page.

Not changed: the new-org default is still `NONE`. It is now visibly "Tracking only — routes are
tracked, not served" everywhere, but defaulting to Caddy would auto-bind 80/443 on every new org's
managers, which is a product decision. `edge-per-node` still has no dashboard control. Also, its
host-path Caddyfile contract (`/var/lib/swarmy/ingress`) is not satisfied by the docker-backend agent
install, which mounts a named volume at `/var/lib/swarmy`, not the host dir. That needs an installer
change before edge-per-node can work there.
