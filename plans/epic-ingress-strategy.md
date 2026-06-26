# Epic: Ingress strategy — pluggable selection, Caddy HA (shared certs), Cloudflare Tunnel

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11/Hono, Prisma 7/Postgres, agent dial-out WS, `@swarmy/ingress` driver registry + `RenderedConfig` + `applyIngress` command). Do not redesign the scaffold; this epic *refines* the ingress that already exists.

## Problem

Ingress is the single hardest part of "anyone can just deploy — it has to be that simple." A user with one domain and one node should get working HTTPS with zero decisions. A user with three nodes behind a load balancer should get HTTPS that survives any node dying *without re-issuing certificates on every box and tripping Let's Encrypt rate limits*. A user with **no public IP at all** (homelab, behind CGNAT, a laptop) should still be able to expose a service to the internet. And a user who already runs their own Caddy/Traefik/nginx must be able to keep doing exactly that and have swarmy stay out of the way.

The scaffold already nails the *shape* of this: a pluggable `IngressDriver` registry (`caddy | traefik | none`), a pure `render(config) -> RenderedConfig`, a generic `applyIngress` agent command that writes files / sets labels / reloads, and a `DriverDispatch` seam so drivers never touch the WebSocket. What's missing is the *strategy*:

1. **Which driver is the default, and do we keep Traefik?** Two reverse proxies is two codepaths, two cert stories, two debugging surfaces. We should be opinionated about the default and honest about what we keep.
2. **Caddy in HA is unsolved.** Today `CaddyDriver` fans the same Caddyfile to every target node (`apply()` → `sendToNode` per node). Each Caddy instance independently obtains its own certs from its own ACME account into its own local storage. With N ingress nodes that's N× ACME issuance, N× rate-limit pressure, and N independent on-demand-TLS decisions. There is no shared cert store and no clustering.
3. **No zero-public-IP option.** `none` means "you do it"; `caddy`/`traefik` assume inbound 80/443 reaches a node. Nothing covers CGNAT/homelab. Cloudflare Tunnel (and friends: ngrok, tailscale-funnel) solve this but need credential provisioning and a different "apply" model (run a connector, not write a vhost).
4. **Selection granularity.** `IngressConfig` is one-per-org (`orgId @unique`). Real users want "this stack goes through Cloudflare Tunnel, the rest through Caddy." We need per-stack / per-domain driver selection without throwing away the simple org-default.
5. **"none" must stay first-class** — the unopinionated promise. Selecting a managed driver is opt-in; the default install touches nothing.

## Recommended approach

### Driver lineup: **Caddy is the recommended default. Keep Traefik. Add `cloudflare-tunnel`, `tailscale-funnel`, `ngrok`. Keep `none` first-class and as the literal default until the user opts in.**

**Default reverse proxy = Caddy.** Why Caddy over Traefik for *our* audience and architecture:

- **Automatic HTTPS is the product.** Caddy issues, renews, and serves certs with zero config — `example.com { reverse_proxy app:3000 }` and you have HTTPS. That *is* the swarmy promise. Traefik can do ACME too but needs explicit resolvers/entrypoints/providers wiring; more knobs = more ways for a beginner to get a broken cert.
- **On-demand TLS** (issue a cert on first TLS handshake for a hostname, gated by an `ask` endpoint) is a Caddy first-class feature and is *exactly* what a multi-tenant "bring your own domain / custom domains" product needs. Our controller already exposes an HTTP API — it can *be* the `ask` endpoint, answering "is this domain registered to an org?" in a constant-time DB lookup. Traefik has no equivalent.
- **HA via shared storage is a documented, battle-tested pattern**: point every Caddy instance at the same storage backend (Redis) and they share one ACME account + one cert pool. One issuance, reused everywhere. (Details below.) Traefik's HA cert story is weaker: file provider gives no cert sharing; you need Traefik *Enterprise* or a KV/Consul + acme.json dance that is fiddly and historically race-prone.
- **The render model already fits.** `CaddyDriver.render()` emits a Caddyfile file + reload command today. Adding a global `storage redis {…}` block and an `on_demand_tls { ask … }` block is a pure string change in `buildCaddyfile()` — no agent change.

**Keep Traefik — do not drop it, but demote it.** Reasons to keep: (a) it's the de-facto standard for Docker label-based routing; a large cohort *expects* `traefik.http.routers.*` labels and we already render them (`buildTraefikLabels`). (b) Teams with existing Traefik dashboards/middleware ecosystems want it. (c) Our driver abstraction makes the marginal cost of keeping it low — it's already written. We position Traefik as **"advanced / bring-your-own-Traefik"**, not the recommended path, and we do *not* invest in making Traefik HA-clustered ourselves (that's the Enterprise-license rabbit hole). For users who want Traefik HA, the `none`-style "we set labels, you run the Traefik you want" posture is the honest answer.

**Add three tunnel drivers** for zero-public-IP exposure, with **Cloudflare Tunnel as the recommended one**:

- **`cloudflare-tunnel`** (cloudflared) — the marquee feature. Free, custom domains, real certs (Cloudflare-terminated), no inbound ports, runs as a Swarm service, programmatically provisionable via the Cloudflare API. This is the "I have no public IP but I want `app.mydomain.com` to work" button.
- **`tailscale-funnel`** — for users already on Tailscale; `tailscale funnel 3000`-class simplicity, HTTPS on a `*.ts.net` name, no custom domain. Great for internal tools / quick shares.
- **`ngrok`** — most frictionless for ephemeral/dev/demo; reserved domain on paid plans. Lowest commitment, good for "show someone my thing right now."

These three share one **`TunnelDriver` sub-shape** of `IngressDriver`: instead of rendering a vhost file for an existing proxy, they render a **connector deployment** (a Swarm service running the connector image) + a **credential reference** + (for Cloudflare) **API-driven ingress rules**. The agent already knows how to deploy services (`deployService`) and write files (`applyIngress`); tunnels reuse both with a thin new render type. No connector ever needs an inbound port — they all dial out, which is philosophically identical to swarmy's own agent.

### Caddy HA: **caddy-storage-redis (`pberkel/caddy-storage-redis`) + a swarmy-managed Redis service, on-demand TLS `ask` = the controller.**

The mechanism, concretely:

- **Shared cert store = Redis.** Build a Caddy image with the `pberkel/caddy-storage-redis` module (a maintained rewrite of `gamalan/caddy-tlsredis`; supports standalone, Sentinel failover, and Redis Cluster; stores certs/ACME-account/locks with at-rest encryption and an index via sorted sets). Every Caddy instance gets a global `storage redis { … }` block pointing at the same Redis. **Result: one ACME account, one set of certs, issued once and read by all instances.** A new ingress node joins and immediately serves existing certs from Redis — no re-issuance, no rate-limit hit. Distributed locks in the store prevent two instances from issuing the same cert simultaneously.
- **Where Redis runs.** swarmy stands up Redis *itself* as a managed Swarm service (new, small "ingress support" deployment), pinned with a placement constraint to a **manager node** with a persistent local volume (and `--volumes` backup eligible via the volumes/DR epic). Redis here is **cert/coordination storage, not request-path** — if it blips, Caddy keeps serving already-loaded certs from memory; only *new* issuance/renewal pauses. So a single Redis replica is an acceptable MVP (low blast radius), with an optional Sentinel/Cluster topology later for users who want issuance HA. We do **not** put Redis on the request hot path, which is what makes "single Redis" tolerable. (The volumes/DR epic's Garage/restic can back up the Redis volume so cert state itself is recoverable.)
- **On-demand TLS, gated by the controller.** For "custom domains" (users pointing *their* domain at the swarm), set Caddy global `on_demand_tls { ask https://<controller>/ingress/on-demand-check }`. The controller answers 2xx **only** if the hostname is a registered `Domain` for some org (constant-time indexed lookup, no network calls, returns in single-digit ms as Caddy requires). This prevents the classic on-demand-TLS abuse (attacker pointing arbitrary domains at you to exhaust ACME). The `ask` endpoint is a public, unauthenticated, read-only Hono route — narrow and safe.
- **Multiple ingress nodes, identical config.** `CaddyDriver.apply()` already fans the rendered Caddyfile to every target node. With Redis storage in that Caddyfile, fanning the *same* config to N nodes now Just Works as a cluster — the only change is the render adds the `storage`/`on_demand_tls` blocks. Optionally we run Caddy as a Swarm `global`/replicated service so Swarm itself schedules it on ingress-labelled nodes; both models are supported (file-on-node vs service), mirroring the existing `applyVia: file | admin` switch.

Why not alternatives for the shared store: **caddy + S3/object storage** plugins exist but are higher-latency for the lock/issuance path and we'd still need *something* for fast locks; Redis is the canonical, lowest-friction choice and we likely already want Redis around for other features. **Caddy's native "cluster" via shared filesystem** (NFS) reintroduces a shared-FS dependency we explicitly avoid in the volumes epic. Redis wins.

### Cloudflare Tunnel: **remotely-managed (token) tunnels, provisioned via the Cloudflare API by the controller.**

cloudflared supports two modes: locally-managed (`credentials.json` on the box, `config.yml` ingress) and **remotely-managed (a single tunnel *token*, ingress rules pushed via API)**. We use **remotely-managed**, because:

- Cloudflare explicitly recommends token-based tunnels for Docker; the connector needs only the token to run (`cloudflared tunnel run --token <TOKEN>`), which maps perfectly to a Swarm service with the token as a Docker **secret** — no file to copy, no per-node credential material.
- Ingress rules (hostname → `service:port`, plus the mandatory catch-all 404) are configured **server-side via the API**, so swarmy edits routing without touching the running connector. Adding a domain = one API call, not a connector redeploy.
- It scales horizontally for free: run the *same* token on multiple replicas and Cloudflare load-balances across them — instant tunnel HA with a Swarm `replicas: N`.

Provisioning flow (controller-side, on driver enable):
1. `POST /accounts/{acct}/cfd_tunnel` with `{ name, config_src: "cloudflare" }` → returns tunnel `id` + run **`token`**.
2. Store the token encrypted (credential vault, below); deploy a `cloudflared` Swarm service via `deployService` with the token injected as a secret.
3. On every domain add/remove: `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations` with the full `ingress` array (each `{ hostname, service: "http://<swarm-service>:<port>" }`) terminated by a catch-all `{ service: "http_status:404" }`.
4. Create the DNS route: `PUT`/`POST` the DNS CNAME `hostname → <tunnel-id>.cfargotunnel.com` (proxied), or call the tunnel route DNS endpoint. (When the user's zone is on Cloudflare we do this automatically; when it's not, we surface the CNAME for them to add — see Simplicity note.)

Credential input: the user pastes a **scoped Cloudflare API token** (Account: Cloudflare Tunnel Edit + Zone: DNS Edit) once. We never need their global key. For the absolute-zero-config path, a "quick tunnel" (random `*.trycloudflare.com`, no account) is offered for demos.

ngrok / tailscale-funnel follow the same `TunnelDriver` contract with different credential shapes (ngrok authtoken + optional reserved domain; tailscale auth key + funnel enablement) and different connector images. Their "ingress rules" are simpler (single upstream), so most of the Cloudflare machinery degrades to a no-op for them.

## Architecture & integration

Everything below extends the *existing* `@swarmy/ingress` registry, `RenderedConfig`, and `applyIngress` — no new transport, and the agent stays "applies generic intent."

### `@swarmy/ingress` — driver registry additions

Register four new drivers alongside the existing three in `registry.ts`:

```
new IngressRegistry()
  .register(new NoneDriver())            // default, listed first
  .register(new CaddyDriver())           // recommended
  .register(new TraefikDriver())         // advanced / BYO
  .register(new CloudflareTunnelDriver())
  .register(new TailscaleFunnelDriver())
  .register(new NgrokDriver())
```

`NoneDriver` is registered **first** so any "first in list" UI defaulting keeps the unopinionated posture. The `IngressDriver` interface is unchanged for Caddy/Traefik. Tunnel drivers implement the same interface but their `render()` returns a `RenderedConfig` whose new fields (below) describe a connector deployment rather than a vhost; their `apply()` uses `DriverDispatch` to deploy the connector service + (for Cloudflare) calls the controller's CF-API client. To keep drivers transport- *and* cloud-agnostic, extend `DriverDispatch` with a minimal `deployConnector(nodeId|service, spec)` and an opaque `callProvider(op, payload)` seam (implemented in `apps/api`, like `sendToNode` is), so the CF API client lives controller-side, never in the pure package.

`CaddyDriver` changes (all in `render/caddyfile.ts`, pure):
- Emit a global `storage redis { host … port … key_prefix caddy_<orgId> tls_enabled … encryption_key … }` block when HA is enabled (new `globalOptions.haStorage`).
- Emit `on_demand_tls { ask <controllerAskUrl> }` when on-demand is enabled (already partly present via `extra.onDemandAsk`; formalize it).
- No change to `apply()` — fanning the same (now cluster-aware) Caddyfile to N nodes *is* the cluster.

### Wire protocol — `packages/core/src/protocol/ingress.ts`

Additive, backward-compatible. Extend `IngressDriverName` enum: `['none','caddy','traefik','cloudflare-tunnel','tailscale-funnel','ngrok']` (keep the DB enum in lockstep). Extend `RenderedConfig` with an **optional** `connector` block so existing Caddy/Traefik renders are untouched:

```ts
connector: z.object({
  kind: z.enum(['cloudflared','tailscale','ngrok']),
  service: ServiceSpec,            // reuse existing ServiceSpec — agent already deploys these
  secrets: z.array(z.object({ name: z.string(), ref: z.string() })), // resolved just-in-time, never inlined
}).optional()
```

The agent's `applyIngress` handler (in `apps/agent/src/executor.ts`) gains one branch: if `rendered.connector` is present, deploy/update that Swarm service (it already has `deployOrUpdate`) with the referenced secrets, instead of (or in addition to) writing vhost files. Everything else (`files`, `serviceLabels`, `reloadCommand`, `adminApi`) is unchanged, so Caddy/Traefik flows are byte-for-byte the same. No new top-level command type is needed — `applyIngress` already carries `RenderedConfig`; we're enriching the payload, and progress still flows over the existing `commandResult` correlation.

The **Cloudflare API calls themselves are controller-side** (create tunnel, push configurations, DNS route) — they do *not* go through the agent, because they target Cloudflare's API over normal HTTPS from `apps/api`, not the node's Docker socket. The agent's only job is running the connector container.

### DB models — `packages/db/prisma/schema.prisma`

Extend the `IngressDriver` enum to match the wire enum (`CADDY TRAEFIK NONE CLOUDFLARE_TUNNEL TAILSCALE_FUNNEL NGROK`).

Per-stack/per-domain selection without breaking the one-per-org default:
- Keep **`IngressConfig`** (`orgId @unique`) as the **org default**. Add `haStorage Json` (Redis coords, encrypted secrets refs) and `onDemandTls Boolean` to it (currently these live loosely in `settings Json` — promote the load-bearing ones, keep `settings` for the escape hatch, exactly as `globalOptions.extraConfig` does today).
- Add **`ingressDriver IngressDriver?`** (nullable = "inherit org default") to **`Stack`** and to **`Domain`**. Resolution order at render time: `Domain.ingressDriver` → `Stack.ingressDriver` → `IngressConfig.driver`. This gives per-stack and per-domain selection with the org default as the floor; `null` everywhere = today's behaviour.
- New model **`Tunnel`** (org-scoped, cuid + timestamps, mirrors `IngressConfig`'s shape): `{ id, orgId, provider (enum CLOUDFLARE|TAILSCALE|NGROK), externalId (CF tunnel id), name, status, credentialRef (encrypted API-token ref), tunnelTokenRef (encrypted run token), settings Json, createdAt, updatedAt }`. One tunnel can back many `Domain`s.
- New model **`IngressCredential`** (or reuse a shared secrets table if the volumes/DR epic introduces one — coordinate): `{ id, orgId, kind, ciphertext, createdAt }`. Holds the CF API token, CF run token, ngrok authtoken, tailscale auth key, Redis encryption key — all encrypted at rest (libsodium sealed box / `BETTER_AUTH_SECRET`-derived KEK). **Never** written to a node's disk; injected as Docker secrets / command env just-in-time, same discipline as the volumes epic's restic password.
- `Domain` already has `host`/`serviceId`/`targetPort`/`tlsMode` — the on-demand `ask` endpoint reads straight off this table (indexed on `host`).

### tRPC — `packages/trpc/src/routers/ingress.ts` + new `tunnels` router

Extend `ingressRouter`:
- `setDriver` input enum widened to the six drivers.
- `setHaStorage` (adminProcedure): configure/enable Redis-backed HA (or `provisionRedis` to have swarmy stand up the managed Redis service).
- `setOnDemandTls` (adminProcedure): toggle + sanity-check that the `ask` URL is the controller.
- `addDomain` gains optional `ingressDriver` + `stackId` so a domain can pin a driver.
- `previewConfig` already exists and is pure — it now also previews tunnel connector specs and the CF ingress-rule JSON (great for the "show me what this does" UX).

New `tunnelsRouter`:
- `list`, `create` (provider, paste credential) → controller calls CF `POST /cfd_tunnel`, stores token, deploys connector.
- `attachDomain` / `detachDomain` → re-`PUT` CF configurations + DNS route.
- `status` → connector health (via existing node snapshot) + CF tunnel status.
- `rotateCredential`, `delete` (tears down connector service + deletes CF tunnel).

Services layer (`packages/trpc/src/services/ingress.service.ts` + new `tunnel.service.ts` + `cloudflare.client.ts`): houses the CF API client and the `DriverDispatch` impl wiring. A new **public** Hono route in `apps/api` (outside tRPC/auth): `GET /ingress/on-demand-check?domain=…` → constant-time `Domain` lookup → 200/403. Audited like everything else (writes to `AuditLog` on config changes; the high-volume `ask` checks are *not* audited per-request to avoid log spam — only anomalies).

### apps/api — workers & gateway

- **Redis lifecycle**: a small startup/reconcile step (alongside existing metrics workers) that ensures the managed Redis service exists when any org enables Caddy HA, and that the Caddy cluster's `storage` block points at it.
- **Cloudflare reconciler**: on domain/tunnel changes, recompute the full CF `ingress` array + DNS and `PUT` it (idempotent; CF config is declarative, so we always push the complete desired state — no diffing fragility).
- **on-demand `ask` endpoint**: the public Hono route above.
- The agent WS gateway needs **no protocol change** — `applyIngress` just sometimes carries a `connector`.

### apps/app — UI surfaces

- **Ingress page**: driver picker presented as cards with a clear hierarchy — **None (default, "I manage routing")**, **Caddy (recommended, automatic HTTPS)**, **Cloudflare Tunnel (no public IP needed)**, then **Advanced** (Traefik, Tailscale, ngrok) folded behind a disclosure. Each card one-lines what it requires (a public IP? a domain? a Cloudflare account?).
- **HA toggle** on the Caddy card: "Run on multiple nodes with shared certificates" → provisions Redis + sets ingress-node placement. One switch.
- **Tunnel setup wizard**: paste CF API token → we create the tunnel, deploy the connector, and show the exact CNAME (auto-added if the zone is on Cloudflare). Live status chip.
- **Per-domain driver override** in the add-domain dialog (defaults to "inherit").
- **Config preview** (drives off the existing `previewConfig`): shows the rendered Caddyfile / CF ingress JSON before apply — keeps the "no magic" trust.

## MVP vs later

**MVP (ship the promise):**
- `none` stays default and first-class (already done — verify, don't regress).
- **Caddy single-node** with automatic HTTPS (already mostly there) + formalized `email`/TLS UX.
- **Caddy HA**: caddy-storage-redis image + managed single-instance Redis on a manager node + the `storage redis` render block. The headline reliability win.
- **On-demand TLS** with the controller `ask` endpoint (unlocks custom domains).
- **Cloudflare Tunnel** (remotely-managed token, API-provisioned, connector as Swarm service, DNS auto when zone is on CF). The headline reach win.
- Per-stack/per-domain driver resolution (`Domain`/`Stack.ingressDriver` → org default).
- Keep Traefik working exactly as today (no new investment).

**Later:**
- Redis Sentinel/Cluster topology for *issuance* HA (MVP single Redis is fine for the read path).
- Caddy admin-API live reload cluster (vs file+reload) and Caddy-as-Swarm-global-service mode polish.
- tailscale-funnel and ngrok drivers (lower demand than Cloudflare; same `TunnelDriver` contract makes them cheap follow-ups).
- L4/TCP & wildcard-cert support, custom Caddy directives / middleware passthrough, Traefik middleware catalog.
- Multi-region ingress coordination (ties into the geo-DNS epic).
- "Quick tunnel" (`*.trycloudflare.com`) zero-credential demo path.

## Dependencies

- **Credential vault**: needs an encrypted-secret store + just-in-time injection. Coordinate with the **volumes/DR epic** (which introduces the same discipline for the restic password / S3 creds) so there's *one* `*Credential` mechanism, not two. Pick a shared `Credential` table + KEK derivation.
- **Managed Redis service**: depends on the deploy path (`deployService`) — already exists. Its persistent volume should be **backup-eligible via the volumes/DR epic** (cert state recovery).
- **Ingress-node labelling / placement**: depends on `updateSwarmNode` (exists) to label which nodes carry ingress.
- **geo-DNS / multi-region epic**: for multi-region ingress, the DNS automation here should reuse that epic's DNS-provider abstraction rather than hardcoding Cloudflare DNS twice.
- External: a Cloudflare account + scoped API token (user-supplied); a Tailscale tailnet / ngrok account for those drivers. cloudflared ≥ 2025.4.0 for remotely-managed tunnels (pin the connector image).

## Risks & open questions

- **On-demand TLS abuse / `ask` latency.** If the `ask` endpoint is slow or wrongly open, attackers can drive ACME issuance for arbitrary hostnames. Mitigation: indexed constant-time `Domain` lookup, deny-by-default, rate-limit, and consider a short in-process cache. The endpoint must be reachable from every Caddy node — fine, it's the controller they already talk to, but document the network requirement.
- **Single Redis = issuance SPOF.** Acceptable because it's off the request path (served certs stay in memory), but a long Redis outage blocks renewals → eventual expiry. Mitigation: alerting on Redis health + cert-expiry, and the Sentinel/Cluster upgrade path. Open question: do we co-locate Redis with the controller or run it as a swarm service? (Recommendation: swarm service, manager-pinned, so it's part of the data plane the agent manages, not the control plane.)
- **caddy-storage-redis maintenance/version risk.** It's community-maintained. Mitigation: pin a known-good module version, build our own Caddy image in CI, and keep the storage interface behind `globalOptions.haStorage` so swapping to another backend (or future official support) is a render change, not an architecture change.
- **Cloudflare API token scope & blast radius.** A DNS-Edit token is powerful. Mitigation: document the minimal scopes (Tunnel Edit + DNS Edit on the chosen zone), store encrypted, support rotation, and offer the "we show you the CNAME, you add it" mode for users who won't grant DNS-Edit.
- **Cloudflare ToS / "no public IP" expectations.** Free tunnels are great but Cloudflare's ToS restricts serving large non-HTML files through the proxy; surface this so users don't build a media host on it unknowingly.
- **Two-proxy support burden.** Keeping Traefik means two cert/render/debug paths. Mitigation: freeze Traefik feature scope (no swarmy-owned Traefik HA), label it "advanced," and let the shared `IngressDriver`/`RenderedConfig` contract absorb most of the cost.
- **Per-domain driver mixing edge cases.** A domain on Cloudflare Tunnel and another on Caddy on the same service is fine; but a single domain can't be on two drivers. Validate one-driver-per-host at the tRPC layer.
- **Open question:** for Caddy HA, file-on-each-node vs Caddy-as-Swarm-service — both work with Redis storage; default to file-on-node (matches current `apply()`), expose service-mode as opt-in.

## Simplicity note

The default install selects **`none` and touches nothing** — the unopinionated promise is intact; swarmy is invisible until you ask for ingress.

When a user *does* want ingress, the happy path is one decision and one field:
- **"I have a domain and a public IP"** → pick **Caddy**, type your email, add a domain. HTTPS appears automatically. Done. (Multi-node? Flip one **HA** switch — swarmy provisions Redis and shares certs for you; the user never learns the word "ACME account.")
- **"I have no public IP"** → pick **Cloudflare Tunnel**, paste one API token. swarmy creates the tunnel, runs the connector as a service, and (if your zone is on Cloudflare) adds the DNS record. Your app is on the internet with real HTTPS, no ports opened, no IP needed.

Everything heavier — Redis topology, on-demand-TLS gating, per-stack driver overrides, Traefik labels — is **invisible by default and additive**. The `previewConfig` surface means there's never magic: you can always see the exact Caddyfile or tunnel rules before they apply. New capabilities arrive as new drivers in the registry, not as agent rewrites, so "the agent applies generic intent" stays true and the simple cases stay one-command simple.
