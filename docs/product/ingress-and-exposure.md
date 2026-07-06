# Ingress & exposure — "deployed isn't reachable until swarmy makes it so"

**Status: canonical product design (2026-07). Pairs with the
`scaffold-ingress-driver` skill for the how; exposure pairs with
`docker-native-storage`.**

## The feeling we are building

A container running on the swarm is not yet a website. Someone who just deployed
`web:1.8.2` has replicas up and a private overlay address — and nothing the
outside world can reach. Ingress is the step that turns "it's running" into
"it's on the internet with HTTPS," and it should feel like flipping one switch,
never like a certificate project.

1. On a stack's **Network** tab they see **Domains & routes** — "3/3 secured."
   Each row is `shop.acme.com → web:3000`, `TLS auto`, with policy chips:
   `100 req/min`, `bots blocked`, `canary 10%`. A route is a sentence, not a
   config file.
2. They add a domain: type the host, pick the service and port, leave TLS on
   **auto**. Within a handshake the certificate is issued and the padlock is
   real — no ACME account to create, no `acme.json` to babysit.
3. They have three ingress nodes behind a load balancer. They flip **HA** once:
   "run on multiple nodes with shared certificates." A cert issued on one node is
   instantly served by all of them; a fourth node joins and serves the *existing*
   cert with zero re-issuance. They never learn the words "ACME account."
4. They have **no public IP** — a homelab behind CGNAT. They pick **Cloudflare
   Tunnel**, paste one scoped API token, and their app is on the internet with
   real HTTPS and zero inbound ports. The connector dials out, exactly like the
   agent does.
5. Separately, on **Exposure**, they see every service audited into **PUBLIC**,
   **PRIVATE**, **MANAGED INTERNAL** — and one red banner: *"1 exposure
   violation needs you."* A managed Postgres is publishing 5432 to the world.
   swarmy names it, tells them how to fix it, and — in v1 — **never pulls the
   port itself. The fix is always yours to make.**

The unopinionated promise holds underneath all of this: the default driver is
**`none`**, which stands up no process and touches nothing. swarmy is invisible
until you ask it to put something on the internet.

## How it works (the request path)

```
service carrying the swarmy.ingress.routes label      dashboard: stack → Network
   │  ① a route is one JSON entry on the service label (Docker truth):
   │     { host, port, tls, protection?, canary?, cold?, regionUpstreams? }
   ▼
controller renders — pure driver.render(config) → RenderedConfig
   │  ② none · caddy · traefik · cloudflared · nginx · haproxy
   │     { files, serviceLabels, reloadCommand | adminApi, connector? }
   ▼
DriverDispatch.sendToNode(nodeId, rendered)      (down the agent's OUTBOUND WS)
   │  ③ agent writes files, sets labels, execs `caddy reload` in the LOCAL task
   │     — or, for a tunnel, deploys the connector as a Swarm service (dials OUT)
   ▼
Caddy issues + serves the cert · request reaches service:port over the overlay
   │  ④ HTTPS is automatic; with HA a new node serves existing certs from Redis
   ▼
your app is reachable  ──►  Exposure audit says exactly HOW it's reachable
```

Four ideas, one story:

- **A route is a label, not a database row.** Everything about how a service is
  fronted — host, port, TLS mode, rate limits, bot blocking, canary weight,
  scale-to-zero, region siblings — lives in the `swarmy.ingress.routes` JSON
  array on the Docker service. Docker is the source of truth; swarmy renders from
  it and can always show you the exact config before it applies.
- **Drivers are pure; the agent applies.** A driver is `render(config) →
  RenderedConfig` with no IO. The controller renders, `DriverDispatch.sendToNode`
  ships the payload down the node's outbound WebSocket, and the agent writes the
  files and reloads. The same seam serves a vhost proxy (Caddy/Traefik/nginx/
  HAProxy) and a tunnel connector (cloudflared) — the latter just carries a
  `connector` Swarm-service spec instead of vhost files. See the
  `scaffold-ingress-driver` skill.
- **Automatic HTTPS is the product, and it survives node death.** Caddy is the
  recommended default because `example.com { reverse_proxy web:3000 }` *is* an
  HTTPS site. HA shares one ACME account + one cert pool across every Caddy via a
  Redis-backed store, so N ingress nodes cost 1× issuance, not N×.
- **No public IP is still reachable.** The cloudflared connector dials out to
  Cloudflare and Cloudflare terminates TLS; swarmy provisions the tunnel over the
  Cloudflare API controller-side and runs the connector with its run token as a
  Docker secret — never a file on the node, never on the `ps` line.

## Roles and where truth lives

- **Routes are Docker truth.** The `swarmy.ingress.routes` service label
  (`INGRESS_ROUTES_LABEL`) is the one home for per-service routing; `readRoutes`
  parses it and the renderers consume it. There is **no `Domain` model** — the
  on-demand-TLS `ask` endpoint and the exposure audit both read hosts straight
  off live inventory, never a mirrored DB column.
- **Edge roles + region are Docker node labels**, shared with the edge stack:
  `swarmy.node.ingress` (this node terminates public traffic),
  `swarmy.node.public-ip`, `swarmy.region`. Marking a node with the ingress label
  is what places the edge Caddy plane there. See `docs/product/edge-network.md`.
- **What swarmy's DB owns is only its own config + encrypted credential
  pointers.** `IngressConfig` (one per org: `driver`, `enabled`, and a `settings`
  JSON escape hatch for HA storage coords / on-demand `ask` URL / topology),
  `Tunnel` (org-scoped: `provider`, `externalId`, `credentialRef`,
  `tunnelTokenRef`, `status`), and `ExposureConfig` (`rulesJson` + the `enforce`
  flag). Plaintext secrets — Redis password, cert encryption key, CF run token —
  are **never** in these rows; they are vault pointers resolved just-in-time at
  dispatch and injected as env/secrets. See the `docker-native-storage` skill.
- **The exposure verdict is derived every time, never stored.** `auditExposure`
  classifies each live service on read; the only persisted thing is the rule
  toggles.
- **Direction (adopted 2026-07, being built): exposure becomes *declared*, not
  just inferred.** Every service will carry an intent — `swarmy.expose` ∈
  `public | tunnel | private | mesh` (a service label, Docker truth) — chosen
  in the UI. Admission enforces intent-vs-spec (a `private` service with a
  published port is refused), and the audit gains drift detection: declared ≠
  observed is itself a violation. The inferred classifier stays — it becomes
  the *observed* half of the comparison. See `plans/roadmap-mini-cloud.md`
  (WS3).

## Ingress & exposure behaviour

- **`none` is the literal default and stays first-class.** It renders empty and
  runs no process — "I manage my own routing." Selecting Caddy or a tunnel is
  opt-in; the six drivers register in order `none, caddy, traefik, cloudflared,
  nginx, haproxy` so any "first in list" default stays unopinionated.
- **TLS is per-route: `auto` (Let's Encrypt), `off`, or `manual`/custom.** Auto
  is the happy path. **On-demand TLS** (custom domains) is gated by the
  controller's public `GET /ingress/ask?domain=…`: it answers 200 **only** for a
  host that is a live `swarmy.ingress.routes` entry for some org — deny by
  default, a 30s positive cache, and intentionally **not** audited per request
  (it is high-volume). This is the standard defence against the ACME-exhaustion
  abuse vector.
- **Per-route protections render into driver syntax, best-effort.** Rate limit
  (sliding window, keyed by IP or header), IP allow/deny CIDRs, body-size cap,
  bot/scanner blocking, required headers. Renderers translate what they can and
  `validate()` *warns* about what a given driver can't express — render never
  throws.
- **Two Caddy topologies, one spec.** `controller` runs a replicated Caddy behind
  the routing mesh; `edge-per-node` runs a **GLOBAL host-mode** Caddy on every
  `swarmy.node.ingress` node with per-node region-aware upstreams (the mode geo
  steering needs — see `edge-network.md`). Switching to edge-per-node cuts over
  the replicated service (seconds of blip, explicit opt-in). The edge spec is
  single-sourced (`caddyEdgeSpec`) so composition never hand-rolls ports/mounts.
- **The agent reloads the LOCAL task only.** It writes the Caddyfile to a host
  path bind-mounted into Caddy and execs `caddy reload` inside the node's own
  task (found by the `com.docker.swarm.service.name` label); admin port 2019 is
  never published. The controller never reaches a node's socket.
- **Exposure audits every service into one of four verdicts, precedence-ordered:**
  `public-port` (publishes a port — world-reachable on every node) > `public-domain`
  (fronted by an ingress route) > `internal-managed` (carries a
  `swarmy.db.*/cache.*/search.*/vector.*` label) > `private`. Managed data that
  publishes a port lands as `public-port` **on purpose** — that is exactly the
  violation.
- **Exposure alerts, it does not amputate (v1).** Rules — no public ports on
  managed data, no public UDP, warn on new published ports — surface on the
  Exposure page and, when **"Block violating deploys"** (`enforce`) is on, refuse
  the *next deploy* through admission (warn-severity is overridable; block is
  not). swarmy never removes a live port by itself. The fix is always yours.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Ingress node dies (HA on) | Its certs are in Redis; a surviving node already serves them and the load balancer sheds the dead node. No re-issuance, no rate-limit hit. |
| Redis (cert store) blips | Served certs stay in memory — the request path is unaffected. Only *new* issuance/renewal pauses until Redis returns. Redis is deliberately off the hot path. |
| Custom domain not yet registered points at the swarm | `/ingress/ask` returns 403 → Caddy declines to issue. No ACME spend on domains that aren't yours. |
| Cloudflare Tunnel: connector or CF blips | Connector dials out and reconnects; no inbound port to fail. Routing rules are declarative server-side, re-pushed idempotently on the next sync. |
| A driver can't express a protection (e.g. rate limit on `none`) | `validate()` warns; `render` still emits a working config for what it *can* do. Degraded, never broken. |
| Managed database publishes a port | Audited as a `public-port` violation, alerted on the Exposure page, and (if enforce is on) the next deploy is refused — but the running port is left in place for the operator to remove. |

## Explicitly rejected

- **A `Domain` DB model mirroring routes.** Routes live on the service label;
  duplicating them in Postgres drifts and forces two writes. The `ask` endpoint
  and the audit both read live inventory. See `docker-native-storage`.
- **Per-node independent certificates.** N Caddy instances each running their own
  ACME account is N× issuance and N× rate-limit pressure. Shared Redis storage
  makes N nodes one logical cert authority.
- **Controller-initiated reloads / reaching a node's socket.** The controller
  renders; the agent applies over its own outbound WS and reloads its own local
  task. Never an inbound connection to a node.
- **Auto-remediating exposure violations (in v1).** Silently deleting a published
  port could sever a database mid-flight. swarmy makes the violation loud and the
  remedy obvious, and leaves the last move to a human.
- **A second reverse proxy as a co-default.** Traefik is kept for label-native
  and BYO users but demoted to "advanced"; swarmy does not invest in
  swarmy-owned Traefik HA. One recommended path (Caddy) keeps the cert story
  singular.
- **Putting Redis on the request path.** It stores certs and issuance locks only,
  which is what makes a single managed Redis tolerable for the MVP.

## Implementation map

The driver contract, `RenderedConfig` shape, and "render pure, apply at the edge"
rule live in the `scaffold-ingress-driver` skill; the exposure "Docker is truth,
DB owns only rules" rule is the `docker-native-storage` skill; the edge-per-node
topology, region-aware rendering, and node public-IP labels are the
`geo-edge-routing` skill (product rationale in `docs/product/edge-network.md`).

Key homes: driver registry + pure drivers `packages/ingress/src/{registry,types}.ts`
and `packages/ingress/src/drivers/{none,caddy,traefik,cloudflared,nginx,haproxy}.ts`;
render helpers `packages/ingress/src/render/*`; wire types (RenderedConfig,
connector, HaStorage, TunnelOptions, DomainRoute, RouteProtection)
`packages/core/src/protocol/ingress.ts` and `packages/ingress/src/types.ts`;
controller services `packages/trpc/src/services/{ingress.service,ingress-controller,
ingress-routes,ingress-routes-api,ingress-regions,tunnel.service}.ts` with the
route label constant in `ingress-routes.ts` (`INGRESS_ROUTES_LABEL`); routers
`packages/trpc/src/routers/{ingress,tunnels,exposure}.ts`; the exposure audit +
admission `packages/trpc/src/services/{exposure.service,admission-exposure}.ts`;
DB rows `packages/db/prisma/schema/ingress.prisma` (`IngressConfig`, `Tunnel`) and
`governance.prisma` (`ExposureConfig`); the public on-demand-TLS gate
`apps/api/src/ingress-ask.ts` mounted at `/ingress/ask` in `apps/api/src/index.ts`;
agent handlers `apps/agent/src/handlers/{ingress-local,ingress-connector,
ingress-status}.ts`; UI `apps/app/src/routes/_authed/{ingress,exposure}.tsx` with
`apps/app/src/components/ingress/*` and `apps/app/src/components/exposure/*`; design
depth in `plans/epic-ingress-strategy.md`.
