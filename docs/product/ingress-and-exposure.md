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
   │  ② none · caddy · cloudflared
   │     { files, serviceLabels, reloadCommand | adminApi, connector? }
   ▼
DriverDispatch.sendToNode(nodeId, rendered)      (down the agent's OUTBOUND WS)
   │  ③ agent writes files, sets labels, execs `caddy reload` in the LOCAL task
   │     — or, for a tunnel, deploys the connector as a Swarm service (dials OUT)
   ▼
Caddy issues + serves the cert · request reaches service:port over the overlay
   │  ④ HTTPS is automatic; edge-per-node shares one cert pool in swarmy object storage
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
  files and reloads. The same seam serves a vhost proxy (Caddy) and a tunnel
  connector (cloudflared) — the latter just carries a
  `connector` Swarm-service spec instead of vhost files. See the
  `scaffold-ingress-driver` skill.
- **Automatic HTTPS is the product, and it survives node death.** Caddy is the
  recommended default because `example.com { reverse_proxy web:3000 }` *is* an
  HTTPS site. Edge-per-node shares one ACME account + one cert pool across every
  Caddy via swarmy's own object storage (Garage bucket `swarmy-edge-certs`), so
  N ingress nodes cost 1× issuance, not N×, and any edge can answer any challenge.
  The bucket is a *replica*, never a dependency: each edge serves from its own
  volume first (`storage swarmy`) and syncs with Garage in the background, so
  no boot path waits on Garage — or on the mesh Garage is reached over — to
  serve TLS (QA-066).
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
  JSON escape hatch for cert-store coordinates / on-demand `ask` URL / topology),
  `Tunnel` (org-scoped: `provider`, `externalId`, `credentialRef`,
  `tunnelTokenRef`, `status`), and `ExposureConfig` (`rulesJson` + the `enforce`
  flag). Plaintext secrets — the cert store's S3 key (a Docker secret only), CF run token —
  are **never** in these rows; they are vault pointers resolved just-in-time at
  dispatch and injected as env/secrets. See the `docker-native-storage` skill.
- **The exposure verdict is derived every time, never stored.** `auditExposure`
  classifies each live service on read; the only persisted thing is the rule
  toggles.
- **Direction (adopted 2026-07): exposure is *declared*, not just inferred.**
  A service may carry an intent — `swarmy.expose` ∈
  `public | tunnel | private | mesh` (a service label, Docker truth; `EXPOSE_LABEL`)
  — chosen on the service page or the Exposure table. Admission enforces
  intent-vs-spec on the incoming specs (a `private` or `mesh` service with a
  published port or ingress route is refused; `tunnel` with a published port is
  refused) — declaring a mode is the per-service opt-in, so it fires even while
  the org-wide `enforce` switch is off (the `enforceDeclaredIntent` rule toggle,
  default on, silences it). The audit carries drift detection: declared ≠
  observed is itself a violation (declared `tunnel` served by a non-cloudflared
  driver included), and "declared public but unreachable" surfaces as a warning.
  The inferred classifier stays — it is the *observed* half of the comparison.
  Open: the background exposure-audit worker doesn't yet alert on
  declared-vs-observed drift (the Safety page's Exposure section does), and the ingress renderer
  doesn't consult `swarmy.expose` — see `plans/ROADMAP.md`.

## Ingress & exposure behaviour

- **Caddy is the default edge for new workspaces; every other driver stays
  selectable.** A new org's `IngressConfig` is created as `CADDY`, enabled
  (`DEFAULT_INGRESS` in `ingress.service.ts`, mirrored by the Prisma column
  default), so a deployed app is browser-reachable with zero setup. An existing
  org's choice is never rewritten. A fresh org with no public IP or domain still
  works: with no routes Caddy renders no site blocks (no ACME order is ever
  placed), a LAN/private-IP host — `*.local`, `192.168.x.y`,
  `app.192-168-64-4.sslip.io` — gets Caddy's local CA (`tls internal`), and a
  public-IP `sslip.io` name gets Let's Encrypt. Until a manager is connected
  the edge reads "down", never a false green. `none` stays first-class — it
  renders empty and runs no process ("I manage my own routing", "Tracking
  only"); Cloudflare Tunnel (paste a tunnel token) is one switch away. Traefik,
  nginx and HAProxy were removed in 2026-09 (owner decision).
  (Owner decision 2026-09-24.)
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
- **The agent reloads the LOCAL task only.** It writes the Caddyfile inside the
  node's own Caddy task (exec over the local docker socket — no host files) and
  execs `caddy reload` there (task found by the `com.docker.swarm.service.name`
  label); admin port 2019 is never published. The controller never reaches a
  node's socket.
- **Cloudflare Tunnel: paste the tunnel token.** The user creates a tunnel in
  Cloudflare Zero Trust and pastes its token; swarmy reads the tunnel id from it
  and runs `cloudflared tunnel run` as a swarm service (token via a Docker
  secret, never argv). Public hostnames are added on the Cloudflare side; the
  ingress preview lists the hostname → service rules to add. More connector
  replicas on the same token is tunnel HA. (Creating tunnels and pushing routes
  through the Cloudflare API was removed in 2026-09 — owner decision.)
  Cloudflare's ToS limits large non-HTML content through its proxy — a tunnel is
  not a media host.
- **Exposure audits every service into one of four verdicts, precedence-ordered:**
  `public-port` (publishes a port — world-reachable on every node) > `public-domain`
  (fronted by an ingress route) > `internal-managed` (carries a
  `swarmy.db.*/cache.*/search.*/vector.*` label) > `private`. Managed data that
  publishes a port lands as `public-port` **on purpose** — that is exactly the
  violation.
- **Exposure alerts, it does not amputate (v1).** Rules — no public ports on
  managed data, no public UDP, warn on new published ports — surface on the
  Safety page's Exposure section and, when **"Block violating deploys"** (`enforce`) is on, refuse
  the *next deploy* through admission (warn-severity is overridable; block is
  not). swarmy never removes a live port by itself. The fix is always yours.

## Custom domains: DNS first, then a certificate

Adding a domain is a guided hand-off, not a hope. Each routed host walks one
honest lifecycle, shown on the row in plain words:

`waiting for DNS → DNS verified → issuing certificate → secured` — or
`error <reason>`.

- **swarmy tells you the exact record.** A/AAAA to the public IPs of the edges
  that actually terminate traffic (the nodes running the Caddy task; else the
  ingress-labelled nodes), or a CNAME to the dashboard domain for non-apex
  names, or NS delegation when the host sits in a zone swarmy serves, or the
  proxied CNAME to a Cloudflare Tunnel. Registrar-shaped: `@`, `www`, `app`.
- **Verification asks the public, not the node.** The controller resolves the
  host over DNS-over-HTTPS on 12 public resolvers from a mix of operators and
  regions (`DOH_RESOLVERS` in `packages/core/src/doh-resolvers.ts`: Cloudflare
  and Google over the JSON API, the rest over RFC 8484 wire format) — what
  Let's Encrypt will see, not a node's split-horizon view. The go-live gate
  (owner decision Q13): at least 3 of every 4 resolvers that ANSWERED point at
  a swarmy edge, and 1.1.1.1 and 8.8.8.8 are among the agreeing ones.
  Resolvers still returning an old answer show as "still cached" and don't
  block; resolvers that time out or error are left out of the count (an
  anchor too). When no public resolver answers (no egress), the controller's
  own resolver and swarmy-dns decide, and each one that answers must agree.
  `SWARMY_DOH_RESOLVERS` picks the list: unset = the 12; `off`/`none`/empty =
  none; otherwise a comma list of preset ids (`cloudflare,google,quad9`) and
  https URLs (JSON API by default, `wire:https://…` for RFC 8484). The anchor
  clause applies only to the anchors that are configured, so a custom list
  without `cloudflare`/`google` is gated on 3-in-4 alone. The dashboard draws
  the answers on a world map at each operator's home city (they are anycast,
  so that is not where the answer came from). It names the usual traps: the old IP
  still propagating, Cloudflare's orange cloud, a stray AAAA (Let's Encrypt
  tries IPv6 first), a leftover extra A record.
- **No certificate order for a name that can't validate.** A domain added
  through swarmy (add domain, set routes, the www toggle) — or declared on
  `swarmy.ingress.routes` in a compose / single-service / builder deploy — is
  withheld from the render, and denied by `/ingress/ask`, until its DNS
  verifies. Every deploy path runs the same gate (`registerDeployRoutes`)
  before the spec lands. Verification is sticky: a later DNS change reports
  `error` but never un-serves a working site. Hosts already routed live when a
  redeploy re-declares them (or that predate this feature) are observed, never
  withheld — un-rendering a working domain would be an outage. An admin can skip the check for a domain behind
  an external load balancer (audited).
- **Certificate status is measured, not assumed.** A TLS handshake from the
  controller to each edge's public IP with SNI = the host: issuer, expiry, and
  which edges serve it. Chosen over reading the cert store (sealed client-side,
  and the single-controller topology keeps certs in a local volume). Feeds the
  default `cert-expiry` alert (warning < 14 days, critical < 3 days or failing).
- **Apex + www is one toggle.** A route's `www` field — redirect www → apex,
  redirect apex → www, or serve both — expands controller-side into routes plus
  a 308 redirect site; the companion host gets its own DNS check and cert. An
  explicit route for the companion always wins.
- **Apex + www redirects.** Caddy renders a 308 redirect site (goldens in
  `packages/ingress/src/render/www.test.ts`).
- **Wildcard certificates, from your own nameservers.** `*.acme.com` can only
  be issued over ACME DNS-01. When the zone is served by swarmy-dns (NS
  delegated to the ingress+outlet nodes), the edge's `dns swarmy` Caddy module
  (`docker/caddy-swarmy/dnsprovider`) POSTs the challenge to the controller
  (`/ingress/acme-dns/<orgId>/{present,cleanup}`); the controller accepts only
  `_acme-challenge.<host>` for a host the org routes inside one of its zones,
  stages the TXT in memory, and pushes the zone to every nameserver before it
  answers. No DNS provider account, no API token. The bearer is derived
  (HMAC of the org id), reaches the edge as a content-addressed Docker secret,
  and is read from the file at each call — never in the Caddyfile, the adapted
  JSON or the autosave. Optional secondary, only for a zone swarmy does not
  serve: a Cloudflare API token (`ingress.setDnsProvider`), stored solely as a
  Docker secret and read with `{file.*}`. Exact hosts keep HTTP-01/TLS-ALPN.
  swarmy-dns answers wildcards (RFC 4592 synthesis), so `*.acme.com` resolves
  and verifies like any other host.
- **Every public app has an address before you own a domain.** A service that
  already publishes an HTTP port (or declares `swarmy.expose=public`, or sets
  `swarmy.ingress.auto=true`) gets a real route
  `<service>-<stack>.<edge-ip>.sslip.io` on first deploy — instantly verified
  (the name embeds the edge IP), a real Let's Encrypt certificate on a public
  IP, the local CA on a LAN IP. The marker label `swarmy.ingress.auto.host`
  makes removal permanent; a custom domain replaces it; an edge-IP change
  re-hosts it; `swarmy.ingress.auto=false` opts out. **Own zone first:**
  flag one delegated swarmy-ns zone (`geodns.setZoneAutoAddresses` — refused
  until public NS already points at swarmy, sticky afterwards) and apps get
  `<service>-<stack>.<zone>` answered by swarmy-dns instead; existing sslip.io
  addresses re-host onto it (through the DNS gate, so the certificate is
  ordered once the name resolves). sslip.io is only the fallback when no zone
  is delegated. Private/mesh/tunnel
  intent, managed data and swarmy's own services never get one — an automatic
  address never widens exposure.
- **Where the state lives.** Check results + the gate are controller
  observations in `IngressConfig.settings.domainChecks` (atomic jsonb merges;
  pruned when the host stops being routed) — not a `Domain` model and not a
  label, so a DNS check never rewrites a service spec. Routes stay on the
  label. Implementation: pure `packages/ingress/src/{domain-verify,www,
  auto-address}.ts`; `packages/trpc/src/services/{domain-verify,auto-address}
  .service.ts`, `domain-checks.store.ts`; the `domain-verify` worker (30s,
  per-host backoff).

## Service-to-service networking (inside the swarm)

The flip side of exposure is who can reach a service from INSIDE the cluster.
Least privilege, by network:

| Network | Who is on it | What resolves |
|---|---|---|
| `<app>_default` (one per app) | every service of that app | short compose names: `db:5432`, `api:8080`, `tasks.api` |
| `<app>_<db>-net` & co (one per managed resource) | the resource + the app services attached to it | its service name, already in the injected `DATABASE_URL` / `REDIS_URL` / … |
| `swarmy-link-<hash>` (one per connected app PAIR) | every app service of exactly two apps of one org | `<service>.<app>` (`api.billing:8080`) and `<app>_<service>` |
| `swarmy` (shared platform) | edge Caddy, OTel collector, Garage, and the app services that are routed / observed / bucket-attached | `<app>_<service>` (the edge's upstream), `swarmy-garage:3900`, `swarmy-otel-collector:4317` — **no user aliases** |
| `swarmy-control` (private) | controller (embedded store), ClickHouse + the trusted bridges (edge, cloudflared, collector, node-#1 agent) | never reachable from an app |

- **Apps are isolated by default; connecting them is explicit.** "Connect
  apps" (`stacks.connect`, swarmy.yaml `connect: [billing]`) creates a private
  overlay for exactly that pair — never a flat network — and never shares the
  apps' managed databases.
- **The control plane is on no network an app can join.** Admission refuses
  a spec naming `swarmy-control` or aliasing any name on `swarmy`, with no
  override: an app aliasing `postgres` or `swarmy_controller` there could
  impersonate the platform to the dual-homed edge/collector.
- **The API tells you what to type.** `stacks.endpoints` lists each service's
  and managed resource's internal names and who can use them — the UI's
  "reach this at `db:5432` from inside storefront".
- **Over the mesh, overlays fit the tunnel.** New overlays get an MTU sized for
  WireGuard (1230, 1170 encrypted) so large packets don't stall across nodes.
- **Known residual:** services on the shared `swarmy` network (routed,
  observed, bucket-attached) can reach each other's VIPs by full name. The fix
  is per-org edge networks, which needs a per-org (or merged-render) Caddy
  first — the edge is one swarm-wide service today.
- Proof on a live swarm: `scripts/verify-networking.sh`.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Ingress node dies (edge-per-node) | Its certs are in the shared object-storage pool; a surviving edge already serves them and geo-DNS sheds the dead node. No re-issuance, no rate-limit hit. |
| Object storage (cert replica) blips | Served certs come from the edge's own volume — the request path is unaffected, and so is a restart. Writes land locally and sync when Garage is back; a host with no local cert yet is issued via ACME directly. |
| The mesh-control / controller node reboots (Garage has no quorum until the mesh is back) | Its edge loads the mesh and dashboard certificates from its own volume, NetBird clients reconnect through it, the mesh comes up, Garage regains quorum, the sync resumes. No manual step (QA-066 — previously a permanent deadlock). |
| Custom domain not yet registered points at the swarm | `/ingress/ask` returns 403 → Caddy declines to issue. No ACME spend on domains that aren't yours. |
| Custom domain added before its DNS record exists | Withheld from the render and denied by `/ingress/ask` until public DNS points at an edge; the row says exactly which record to create. No failed ACME orders, no rate-limit burn. |
| Cloudflare Tunnel: connector or CF blips | Connector dials out and reconnects; no inbound port to fail. Routing rules are declarative server-side, re-pushed idempotently on the next sync. |
| A driver can't express a protection (e.g. rate limit on `none`) | `validate()` warns; `render` still emits a working config for what it *can* do. Degraded, never broken. |
| Managed database publishes a port | Audited as a `public-port` violation, alerted on the Safety page, and (if enforce is on) the next deploy is refused — but the running port is left in place for the operator to remove. |

## Explicitly rejected

- **A `Domain` DB model mirroring routes.** Routes live on the service label;
  duplicating them in the DB drifts and forces two writes. The `ask` endpoint
  and the audit both read live inventory. See `docker-native-storage`.
- **Per-node independent certificates.** N Caddy instances each running their own
  ACME account is N× issuance and N× rate-limit pressure — and under geo-DNS the
  CA's vantage points reach edges that don't hold the challenge. Shared storage in
  swarmy object storage makes N nodes one logical cert authority.
- **Controller-initiated reloads / reaching a node's socket.** The controller
  renders; the agent applies over its own outbound WS and reloads its own local
  task. Never an inbound connection to a node.
- **Auto-remediating exposure violations (in v1).** Silently deleting a published
  port could sever a database mid-flight. swarmy makes the violation loud and the
  remedy obvious, and leaves the last move to a human.
- **More than one reverse proxy.** Traefik, nginx and HAProxy drivers existed
  and were removed (2026-09): protections, region-aware rendering and the cert
  store are Caddy-only, and bring-your-own proxies can use `none`. One path
  (Caddy) keeps the cert story singular.
- **Putting the cert store on the request path.** It holds certs, challenge
  tokens and issuance locks only; served certs are cached in each Caddy.
- **Garage as the only cert store.** It made TLS on the mesh-control node
  depend on Garage quorum, which depends on the mesh, which depends on that
  TLS — a reboot deadlocked forever (QA-066). Node-local first, Garage as a
  background replica; a lost sync costs at worst a duplicate issuance.
- **A dedicated Redis for certs.** A new data service to run, pin and back up;
  the replicated object store already exists and replicates across regions.

## Implementation map

The driver contract, `RenderedConfig` shape, and "render pure, apply at the edge"
rule live in the `scaffold-ingress-driver` skill; the exposure "Docker is truth,
DB owns only rules" rule is the `docker-native-storage` skill; the edge-per-node
topology, region-aware rendering, and node public-IP labels are the
`geo-edge-routing` skill (product rationale in `docs/product/edge-network.md`).

Key homes: driver registry + pure drivers `packages/ingress/src/{registry,types}.ts`
and `packages/ingress/src/drivers/{none,caddy,cloudflared}.ts`;
render helpers `packages/ingress/src/render/*`; wire types (RenderedConfig,
connector, HaStorage, TunnelOptions, DomainRoute, RouteProtection)
`packages/core/src/protocol/ingress.ts` and `packages/ingress/src/types.ts`;
controller services `packages/trpc/src/services/{ingress.service,ingress-controller,
ingress-routes,ingress-routes-api,ingress-regions}.ts` with the
route label constant in `ingress-routes.ts` (`INGRESS_ROUTES_LABEL`); routers
`packages/trpc/src/routers/{ingress,exposure}.ts`; the exposure audit +
admission `packages/trpc/src/services/{exposure.service,admission-exposure}.ts`;
config in swarm-kv via `services/ingress-config.repo.ts` (`IngressConfig`, incl.
the tunnel block) and the `governance.prisma` row (`ExposureConfig`); the public on-demand-TLS gate
`apps/api/src/ingress-ask.ts` mounted at `/ingress/ask` in `apps/api/src/index.ts`;
agent handlers `apps/agent/src/handlers/{ingress-local,ingress-connector,
ingress-status}.ts`; UI `apps/app/src/routes/_authed/{ingress,governance}.tsx` (exposure is a section of the Safety page) with
`apps/app/src/components/ingress/*` and `apps/app/src/components/exposure/*`.
