# Self-reliance: what swarmy still needs from other people's clouds

Status: **audit, 2026-09-24.** Code not changed. Every row was checked against
`apps/`, `packages/` and `scripts/` on that date (node_modules, dist, demo
resolvers, tests and the template catalogue's homepage links excluded).

## Progress (2026-09-24)

| Item | State |
|---|---|
| B3 + B4 | **Built** (7a104fa). BOM `packages/core/src/system-images.ts` (third-party index digests pinned). `system-image-mirror` worker: enables the built-in registry for the bootstrap org at install (`SWARMY_BUILTIN_REGISTRY=0` opts out), deploys it + the Docker Hub pull-through cache (`swarmy-registry-cache`, registry:2 proxy on :5001, `SWARMY_REGISTRY_CACHE_UPSTREAM`), copies the BOM by digest with `regctl` and records `swarmy.mirror.*` labels on the registry service. The hub decorator deploys system images from `localhost:5000/swarmy-system/…@sha256` (runOnce/build fall back to upstream on the agent). Both installers merge `registry-mirrors: ["http://localhost:5001"]` into daemon.json (`apps/api/src/install/docker-registry-mirror.ts`, `SWARMY_REGISTRY_MIRROR`). Not yet: the agent-side mesh images (`netbirdio/netbird`, `tailscale/tailscale` — B1 owner) and the bitnami data images (B5). |
| B6 | **Built** (b034fae). `swarmy-trivy-cache` volume on every scan, daily `trivy-db-refresh` worker, stale DB → `images/scan-db-stale` warning (never a block), `SWARMY_TRIVY_DB_REPOSITORY`. |
| B7 | **Plan updated** (`epic-platform-upgrades.md` §1): feed URL setting, swarmy release key, offline bundle. No upgrade code exists yet. |
| B8 | **Built** (cdd99f2): controller-observed source IP in `registerAck`; echo is last resort; `SWARMY_PUBLIC_IP_ECHO`. The installer's own sslip lookup still echoes (no controller yet at that point). |
| ntfy | **Built** (67c9d8e): server required, UI points at the ntfy template, template's ntfy.sh upstream dropped. |
| DB-IP mmdb | **Built** (bb560f5): Country Lite bundled in the swarmy-dns image (CC-BY 4.0 attribution in image labels, NOTICE and UI). |
| DoH order | **Built** (328589a): system resolver → swarmy-dns → public DoH; `SWARMY_DOH_RESOLVERS`. |
| Image picker | **Built** (3fd281d): built-in registry first, Hub second, Hub hidden when unreachable. |

Owner direction: *"The whole point of Swarmy is to make it your own cloud, so it's
not to depend on any other cloud. Anything we need to run outside, we need to
think about that."*

## The rule this plan proposes

1. **Nothing swarmy runs day to day may need a third-party service.** That covers
   the controller, agents, edge, DNS, mesh, builds, scans, backups and alerts. If
   the internet goes away, a running cluster keeps serving, deploying from its own
   registry, and healing.
2. **Third-party services are allowed only as opt-in choices the user makes**
   (their Git host, their SMTP or alert webhook, their AI provider, Cloudflare or
   Route 53 zones, a registry login for someone else's private image). They are
   never the default and never needed to finish install.
3. **Unavoidable ones are named, kept to first install, and cached.** That means
   a public ACME CA for public certificates and the upstream images on first
   install. After first contact, swarmy keeps its own copy: images in the
   in-swarm registry, the GeoIP database on disk and in the image, and
   certificates in Caddy storage.
4. **Every default external URL gets a setting** (org setting or env), so an
   air-gapped operator can point it at their own mirror without patching code.

Effort: **S** is under a day, **M** is a few days, **L** is a week or more.
**Blocker** means it must land before launch, because it either breaks rule 1 by
default or is a single point of failure for every install.

## Launch blockers

| # | Dependency | Where | Why it blocks | Replacement | Effort |
|---|---|---|---|---|---|
| B1 | **NetBird Cloud** (`api.netbird.io`) as the mesh control plane | `scripts/install-swarmy.sh:417-429,484-515`; default driver `packages/trpc/src/services/mesh.service.ts:221`; `packages/mesh/src/drivers/netbird.ts` | This is the default the installer offers. Remote nodes' private network then depends on a SaaS: no enrolment or ACL change works without it, and the cluster's topology is held by a third party. The Headscale driver exists, but swarmy doesn't run Headscale itself. The WireGuard driver has no NAT traversal. | **Superseded (owner decision 2026-09-24): self-hosted NetBird inside swarmy** — see [`epic-self-hosted-mesh-and-fleets.md`](./epic-self-hosted-mesh-and-fleets.md). The combined `netbird-server` (mgmt+signal+relay+STUN, ~105 MiB) runs as an agent-supervised host-network container on node #1 before `swarm init`, with swarmy (Better Auth `oauth-provider`) as its OIDC provider so people join the mesh with their swarmy/SSO login, scoped per stack. Config sets `disableGeoliteUpdate`/`disableAnonymousMetrics` so it phones nowhere. Installer `--mesh swarmy` becomes the default; NetBird Cloud moves under "external control plane"; Headscale stays an advanced driver. | L |
| B2 | **sslip.io** for every automatic app address and the default dashboard domain | `packages/ingress/src/auto-address.ts:41-56` (hard-coded); `scripts/install-swarmy.sh:167-188`; `apps/api/src/workers/domain-verify.ts:2,33`; `packages/trpc/src/services/bucket-access.service.ts:36` | Every no-domain install gets its dashboard and apps under a free third-party resolver. If sslip.io is down, every such install loses its names at once. It also fails on LAN or air-gapped clients that can't reach public DNS. | (a) **S:** make the base configurable (`SWARMY_AUTO_ADDRESS_BASE` / org setting). `sslipBaseFor` → `autoAddressBaseFor`. (b) **M:** a **cluster zone** served by swarmy-dns (`apps/dns`). The installer takes `--zone apps.example.com`, prints the NS glue, and swarmy-dns answers `<svc>-<stack>.<zone>` from the ingress routes it already knows. It also answers `<a-b-c-d>.<zone>` by synthesis, sslip-style (swarmy-dns has no wildcard/synthetic answers today; add them in `packages/dns/src/answer.ts`). sslip.io stays the zero-config fallback **only when no zone is set**, and the UI labels it "public convenience name". | S + M |
| B3 | **GHCR `ghcr.io/requestflo/*`** for the controller, agent, Caddy build and swarmy-dns images | `scripts/install-swarmy.sh:45-46`; `apps/api/src/env.ts:28`; `packages/trpc/src/services/node.service.ts:613`; `packages/ingress/src/drivers/caddy.ts:22`; `packages/trpc/src/services/dns-deploy.service.ts:32` | Each new node pulls the agent from GHCR, and each redeploy of the edge or DNS pulls from GHCR, so adding a node needs the internet. Tags float (`:latest`). | **Seed the in-swarm registry at install.** The installer pulls once, then `docker push`es swarmy's own images into `registry:2`. Every system service after that references `<registry>/swarmy/*@sha256:…`. Node joins pull from the cluster, not GHCR. This is the same work as the platform-upgrades manifest (deploy by digest), so land it there. | M |
| B4 | **Docker Hub / other upstream images** for system services: `registry:2`, `caddy:2-alpine`, `moby/buildkit`, `aquasec/trivy`, `gcr.io/projectsigstore/cosign`, `restic/restic`, `ghcr.io/wal-g/wal-g`, `dxflrs/garage`, `clickhouse`, `otel/…collector`, `curlimages/curl`, `valkey`, `tailscale/tailscale`, `netbirdio/netbird` | `packages/trpc/src/services/registry-auth.ts:30`; `apps/agent/src/handlers/build.ts:27`; `packages/trpc/src/services/registryPolicy.service.ts:30-31`; `packages/core/src/protocol/backup.ts:30`; `packages/core/src/protocol/dbBackup.ts:53`; `packages/trpc/src/services/garage-render.ts:58`; `packages/trpc/src/services/observability-stack.ts:47-48`; `apps/agent/src/handlers/storage.ts:197`; `apps/agent/src/handlers/mesh.ts:37-38` | These are pulled per node, on demand, anonymously. Docker Hub rate limits (100 pulls / 6h / IP) are hit by a 10-node cluster doing a backup drill. Several tags are `:latest`. | Same seeding as B3. The **platform manifest bundles every system image by digest**, and the installer mirrors them into `registry:2`. Separately, add a **pull-through cache** (`registry:2` with `proxy.remoteurl`; one proxy service per upstream: `docker.io`, `ghcr.io`, `gcr.io`) so user images from Docker Hub are fetched once per cluster. Point dockerd `registry-mirrors` at the Hub proxy via the agent's daemon.json handler. There is no proxy config in the codebase today. | M |
| B5 | **`bitnamilegacy/*` images** for managed Postgres and Redis Sentinel | `packages/core/src/protocol/dbBackup.ts:38`; `packages/trpc/src/services/templates.ts:129` | This is not uptime but supply. Bitnami froze its free catalogue into `bitnamilegacy`, which gets **no security updates**. Managed data would ship on a dead upstream. | Move to the official `postgres` image plus swarmy's own entrypoint for replication and repmgr, or build `swarmy/postgresql` from source in CI into GHCR, then mirror it (B3). Do the same for `valkey` sentinel. | L |
| B6 | **Trivy vulnerability DB** (`ghcr.io/aquasecurity/trivy-db`, also `mirror.gcr.io`), downloaded on **every scan** | `packages/trpc/src/services/registryPolicy.service.ts:355-385` (no `--cache-dir` volume, no `--db-repository`) | Every scan downloads about 60 MB from GHCR. Scans fail offline, and the admission gate can then block deploys. | Add a `swarmy_trivy_cache` volume plus a daily controller job that refreshes the DB once and serves it. Either push the DB as an OCI artifact into the in-swarm registry and set `--db-repository <registry>/trivy-db`, or `--skip-db-update` against the shared cache. The admission gate must **fail open with a warning** when the DB is stale, never block deploys on a missing DB. | M |
| B7 | **Platform upgrade feed and signing**: GitHub Releases plus **cosign keyless** (Sigstore Fulcio/Rekor) | `plans/epic-platform-upgrades.md` §1 (not built yet) | As designed, every upgrade check and verification talks to GitHub and public Sigstore. An air-gapped cluster can't upgrade. | Sign manifests with a **swarmy release key** (cosign key-pair, public key baked into the controller), not keyless. Signing already uses `--tlog-upload=false` / `--insecure-ignore-tlog` (`registryPolicy.service.ts:542,589`). Keep GitHub as the default feed URL but make it a setting. Add **offline bundles** (`swarmy-<ver>.tar` = manifest + all images) with `swarmy upgrade --bundle file.tar`, which loads them into `registry:2`. Fold into that epic before it ships. | M |
| B8 | **Public-IP echo services** (`checkip.amazonaws.com`, `api.ipify.org`, `icanhazip.com`, `ifconfig.me`) | `apps/agent/src/public-ip.ts:10`; `scripts/install-swarmy.sh:209-211` | The agent needs these to stamp `swarmy.node.public-ip`, which feeds geo-DNS answers and auto addresses. One of them is AWS. Offline, the node has no public IP, so no DNS answers point at it. | Resolve the agent's public IP **through the controller first**: the controller sees the agent's source address on the WSS connection, and the edge nodes can echo it. Third-party echo stays a last resort, then the manual override label that already exists. Add a `SWARMY_PUBLIC_IP_ECHO` setting. | S |

## Everything else

### Unavoidable, with mitigation

| Dependency | Where | Required? | Offline behaviour | Mitigation |
|---|---|---|---|---|
| **Public ACME CA** (Let's Encrypt, via Caddy's default issuer) | `packages/ingress/src/render/caddyfile.ts:58-71,315-336` | Only for publicly trusted certs on public names | Existing certs keep serving until expiry (about 90 days). New public names get no cert. Private hosts already use `tls internal`. | Unavoidable for browser-trusted public TLS, and that's fine. Add (S) an **ACME CA setting** (`acme_ca` + EAB) so users can pick ZeroSSL, Google, or their **own step-ca / smallstep**, which is the answer for air-gapped estates. Add a warning when a cert is under 21 days to expiry and renewal is failing. Certs already persist in Caddy storage (S3 on Garage when shared). |
| **Upstream images at first install** (Docker Hub, GHCR, gcr.io) | `scripts/install-swarmy.sh:228-238` (the egress gate already checks `ghcr.io registry-1.docker.io`) | Yes, once | The install refuses to start without egress. | B3 and B4 make it *once*. For air-gap, add (M) an **offline installer**: `install-swarmy.sh --bundle swarmy-<ver>.tar` does `docker load`s everything and skips the egress gate (same bundle as B7). |
| **Docker Engine install** (`get.docker.com`) | `scripts/install-swarmy.sh:233,273-274`; `apps/api/src/install/installer.ts:237-238`; `apps/api/src/install-script.ts:155-156` | Only when Docker is missing | The install fails on hosts without Docker. | Document "pre-install Docker from your distro/mirror" (it's already skipped when present). Add `SWARMY_DOCKER_INSTALL_URL` for a mirror (S). |
| **Install one-liner source** (`raw.githubusercontent.com/requestflo/swarmy`) | `scripts/install-swarmy.sh:5,48,567-575` | Controller install only | Can't bootstrap a controller without GitHub. | `SWARMY_RAW_BASE` is already overridable. The offline bundle (above) carries the stack files. Node installs are already self-hosted: the controller serves `/install`, `/install/bin/manifest.json` and the agent binaries (`apps/api/src/index.ts:167`, `packages/trpc/src/services/agent-release.service.ts`). |

### Optional, stays opt-in (user's own choice)

| Dependency | Where | Default? | Offline behaviour | Action |
|---|---|---|---|---|
| **ntfy.sh** as the ntfy alert server | `packages/core/src/inputs.ts:683`; `packages/trpc/src/services/alerts.service.ts:124`; `apps/app/src/components/alerts/channel-destination-fields.tsx:60,155-156` | **Yes, a silent default** when the server is blank | Alerts to ntfy go to a public third party, and fail offline. | S: remove the default. The server becomes required, and the hint suggests the one-click **ntfy template** (`packages/templates/src/catalog/comms.ts:105-130`, which already exists). Also drop that template's `NTFY_UPSTREAM_BASE_URL: https://ntfy.sh` default (keep it as a documented opt-in for iOS push). |
| **DB-IP Lite / MaxMind GeoLite2** mmdb download | `apps/dns/src/geoip-manager.ts:128-194` (DB-IP is the default source, `apps/dns/src/config.ts:66`) | Yes (`dbip`) | Keeps the last-good file on disk. On a fresh node with no egress there's no geo database, and steering falls back to the region-label continent heuristic (`packages/dns/src/steer.ts:53`). | S: **bundle a DB-IP Lite mmdb in the swarmy-dns image** at build time (CC-BY, redistributable, about 130 MB uncompressed, or ship the country edition at about 8 MB). Download refreshes stay opt-in. M: the controller fetches once and distributes as a Docker config/volume so edge nodes never fetch themselves. The `file` source already allows a self-supplied mmdb. |
| **Public DoH resolvers** (`cloudflare-dns.com`, `dns.google`) for domain verification | `packages/trpc/src/services/domain-verify.service.ts:201-202` | Yes | Custom-domain verification fails offline. Auto addresses are unaffected. | S: try the system resolver and swarmy-dns first. Make the DoH list a setting, and let an empty list mean "system only". |
| **Docker Hub search/tags API** for the image picker | `packages/trpc/src/services/images.service.ts:24,131` | Yes (UI suggestions only) | The picker shows no suggestions. Typed refs still deploy. | S: search the in-swarm registry catalogue (`/v2/_catalog`, tags list) first, and Hub second. Hide the Hub section when it's unreachable. |
| **AWS ECR** provider label | `packages/trpc/src/services/registry-credentials.ts:24,128`; `apps/app/src/components/ci/registry-providers.ts:38-43` | No | n/a | Owner decision: **no ECR token refresh**. Today it's only a label and a hint (no refresh code exists). Keep generic registry creds. Optionally (S) fold ECR/GCR/ACR into "generic" with a note that short-lived tokens are the user's to rotate. The built-in registry stays the default push/pull target. |
| **Tailscale SaaS** control plane (`controlplane.tailscale.com`) | `packages/mesh/src/drivers/tailscale.ts:12`; `packages/trpc/src/services/mesh.service.ts:620` | No (explicit driver) | Mesh control fails offline. | Keep as an opt-in driver. The self-hosted default is B1's in-cluster NetBird (`epic-self-hosted-mesh-and-fleets.md`). |
| **Cloudflare / Route 53 DNS APIs** | `packages/trpc/src/services/geodns-provider.ts:181,281`; `cloudflare.client.ts:23` | No (`swarmy-ns` is the self-hosted mode) | Provider sync pauses; swarmy-ns is unaffected. | None. `cloudflared` tunnel ingress is likewise opt-in. |
| **GitHub / GitLab** (Git apps, social login) | `packages/trpc/src/services/git-providers/{github-app,gitlab}.ts`; `packages/auth/src/config.ts:10,83-84` | No | Builds from that provider pause. Email/passkey login is unaffected. | None. Self-managed GitLab/Gitea/Forgejo are supported via `baseUrl` / the generic provider. |
| **Email APIs** (Resend, Postmark, Mailgun) | `apps/app/src/components/notify/*`; `packages/trpc/src/services/notifications.service.ts` | No (SMTP is supported) | Email fails. | None. SMTP covers self-hosted mail. |
| **Alert webhooks** (Slack, Discord, Telegram) | `packages/trpc/src/services/alerts-channels.ts:214`; `packages/core/src/inputs.ts:671` | No | That channel fails. | None. Generic webhook, ntfy and SMTP are self-hostable. |
| **AI providers** (Anthropic, OpenAI) | `apps/api/src/ai-gateway.ts:345-346`; `packages/trpc/src/services/ai.service.ts:267,283` | No (BYO key) | AI features are off. | None. `custom` base URL points at an in-cluster Ollama / Open WebUI (templates exist). |
| **Template catalogue images** (Docker Hub/GHCR upstreams) | `packages/templates/src/catalog/*` | Only when the user deploys one | The deploy can't pull. | Covered by B4's pull-through cache. |

### Checked and clean

- **Dashboard fonts and assets**: fonts are bundled via `@fontsource-variable/*`
  (`apps/app/src/main.tsx:4-6`), and there are no CDN `<script>`/`<link>` tags in
  `apps/app/index.html`. No remote images or avatars were found.
- **Telemetry and update checks**: none. Nothing phones home. The agent's update
  check reads the **controller's** `/install/bin/manifest.json`
  (`apps/agent/src/cli/update-cli.ts:23`). Agent binaries are built into the
  controller image and served by it.
- **`swarmy.dev` URLs**: only documentation and JSON-schema `$id`, RFC 7807
  `type` URIs, and a systemd `Documentation=` line. Nothing fetches them at
  runtime. `scripts/package-agent.sh:49` defaults `AGENT_WS_URL` to
  `wss://app.swarmy.dev`; packaging for self-hosters must override it (S: remove
  the default and require it).
- **Build-time only**: `scripts/build-agent-binaries.ts:58` fetches from
  `registry.npmjs.org` in CI. That's acceptable; it isn't a runtime dependency.
- **cosign signing**: already key-based with the transparency log off
  (`registryPolicy.service.ts:538-589`), so it has no Sigstore dependency today.
  Keep it that way (see B7).

## Order of work

1. **S batch (one PR each):** B8 public IP via controller; B2(a) configurable
   auto-address base; ntfy default removal; DoH fallback order; in-registry image
   search; ACME CA setting; `package-agent.sh` default.
2. **B3 + B4 + B7** land together inside `epic-platform-upgrades.md`. One
   manifest by digest, mirrored into `registry:2` at install and upgrade,
   key-signed, with an offline bundle and a pull-through cache.
3. **B6** Trivy DB cache + mirror (a small follow-on to 2).
4. **B2(b)** cluster zone on swarmy-dns (the `geo-edge-routing` skill owns it),
   plus a bundled mmdb.
5. **B1** in-cluster self-hosted NetBird as the default mesh
   (`epic-self-hosted-mesh-and-fleets.md`; the `mesh-networking` skill owns it). The installer's `netbird-cloud` choice moves under "external
   control plane".
6. **B5** replace the bitnamilegacy data images (the `managed-data-services`
   skill owns it).

Air-gap acceptance test (add to the e2e gate once 1–4 land): install from an
offline bundle on a host with no default route, join a second node, deploy a
template from the pull-through cache (pre-warmed), then scan, back up and restore.
All of it must pass with egress blocked.
