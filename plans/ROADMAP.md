# swarmy — what's still open

Status: **living list, pruned 2026-10-23.** Every item below was checked against
the code on that date. When you close one, delete its line; when you open one,
add it here or as an `issues/` file.

How the docs fit together:

- **`docs/product/`** — what swarmy is and why (start at `product-shape.md`,
  whose "Estate & stack behaviour" section holds the cross-cutting rules: org
  wall, one vault, additive protocol, audit everything, off by default).
- **`.claude/skills/`** — how to work in the code: invariants and file maps.
- **`plans/`** — only work that is still being designed or built:
  - [`epic-platform-upgrades.md`](./epic-platform-upgrades.md) — one-button,
    health-gated upgrades of every platform component (in progress).
  - [`redesign-build.md`](./redesign-build.md) — the 69-board canvas built in
    Calm Layers: what's built, what's deferred and why (the build record;
    [`redesign-dashboard-2026-09.md`](./redesign-dashboard-2026-09.md) is the
    original proposal it came from).
  - [`epic-git-apps.md`](./epic-git-apps.md) — git-connected apps
    (`swarmy.yaml` v1, provider auth, GitOps loop, builds).
  - [`epic-docker-native-state.md`](./epic-docker-native-state.md) — no
    database server: infra truth from Docker, small infra config in the swarm
    (`swarm-kv`), the rest in embedded SQLite replicated to Garage (planned).
  - [`epic-self-hosted-mesh-and-fleets.md`](./epic-self-hosted-mesh-and-fleets.md)
    — NetBird self-hosted inside swarmy (swarmy as its OIDC provider),
    people on the mesh scoped per stack, and multi-cluster fleets.
  - [`epic-developer-platform.md`](./epic-developer-platform.md) — Railpack
    builds, auth for your apps, DB studio, CLI + MCP, session replay, error
    tracking, analytics, email service, BullMQ queues + queue studio, previews.
  - [`competitive-gaps-2026-09.md`](./competitive-gaps-2026-09.md) — the gap
    analysis vs Dokploy, Coolify and hosted PaaS behind the list below.
  - [`self-reliance.md`](./self-reliance.md) — audit of every runtime
    dependency on a third-party service, with the launch blockers (NetBird
    Cloud, sslip.io, GHCR/Hub pulls, bitnamilegacy, Trivy DB, upgrade feed).
- **`issues/`** — individual bugs found in live testing (`issues/resolved/` is
  the fixed ones).

The original 13 epic design docs, the mini-cloud roadmap (WS1–WS7), the
platform buildout manifest, the founder recommendations and the July 2026
readiness sweep all shipped or were superseded; their live decisions were folded
into `docs/product/` and the skills. They remain in git history
(`git log --diff-filter=D --name-only -- plans/`).

## Owner decisions (2026-09-24)

Decided and done — kept here one release so the calls are easy to find; the
rule itself lives in the linked doc.

- **No silent data loss on DB failover** — a replica is auto-promoted only
  when provably caught up (replay LSN ≥ the primary's last flushed LSN);
  otherwise swarmy holds, alerts, and an admin confirms the shown data-loss
  window. Applies to `primary-replica`, `failover` and `geo` —
  `docs/product/managed-data.md` → "Failover never silently loses data".
- **Caddy is the default edge for new workspaces** (other drivers stay
  selectable; a fresh org without a public IP/domain still works) —
  `docs/product/ingress-and-exposure.md` → "Ingress & exposure behaviour".
- **Destructive actions sit behind the fine-grained policy check** —
  `abacProcedure` on tRPC, `requireAction` on REST, one `authorize` step;
  owners/admins keep everything, members keep drain/scale/restart/domain
  removal — `docs/product/governance-and-access.md` → "Every destructive action
  runs the policy gate".
- **`.design/` deleted** — the skills and `redesign-dashboard-2026-09.md` are
  the design authority.

## Competitive gaps (from `competitive-gaps-2026-09.md`, checked 2026-10-23)

Every launch-blocker in the gap analysis has shipped (2026-09-24): Railpack
zero-config builds, the GitHub App manifest flow with PR checks and comments,
63 templates plus the Coolify importer, Discord/Telegram/ntfy/Gotify channels
with default rules, TOTP 2FA with terminal step-up and session limits, node
disk hygiene, MySQL/MariaDB/Mongo logical backup + restore, and bulk `.env`
paste. So did most of the next tier: the pre-deploy `release` command, DNS-01
wildcards via swarmy-dns, named environments, previews with data, the CLI + MCP
server and the BuildKit registry cache. What is left (none launch-blocking):

- **Environments**: "clone as a new environment" and shared-vs-override
  variables in the dashboard (promote-by-digest exists). M–L.
- **Route basic-auth** as an edge protection (not in the protection model). S.
- **Gitea** as a git provider; a Heroku importer. M each.

## Launch verification

- **DigitalOcean multi-region re-sweep**: 3 droplets / 2 regions — the swarm
  routing mesh (see `issues/swarm-routing-mesh-unreachable-in-lima-vm.md`), real
  public-IP ingress + ACME, and geo-DNS answering per region. Local Lima
  verification passed on 2026-09-22/23.
- Open issues: `issues/manual-recovery-required-not-magical.md`,
  `issues/swarm-routing-mesh-unreachable-in-lima-vm.md`,
  `issues/vm-disk-chronically-full.md`.

## Security & governance

- Sweep the config-level deletes onto `abacProcedure` too (alert
  channels/rules, notification templates, status pages, inbound/outbound
  webhooks, jobs, workflows, backup schedules, AI-gateway keys) — still
  role-gated after the destructive-action sweep (`skill("auth-abac")`).
- SAML SSO rows are stored but skipped at build time (no SAML plugin in the
  Better Auth version in use).
- Open question: a second, agent-side factor for privileged capabilities (node
  shell, mesh, builds), so a compromised controller alone can't use them.
- The controller receives `agentVersion`/`protocolVersions` on register but never
  checks agent ↔ controller skew.

## Edge & exposure

- Declared exposure (`swarmy.expose`): the background exposure-audit worker
  doesn't alert on declared-vs-observed drift (the Exposure page does), and the
  ingress renderer doesn't consult the label.
- Per-domain driver override (`route.driver`) is saved on the route label but
  ignored at render time.
- Country rules: `geoipMmdbPath` has no UI and no automatic mmdb download (reuse
  `apps/dns`'s geoip manager).
- Verify the `edge-per-node` topology on a real multi-node swarm now that the
  Caddyfile is written inside the task rather than to a host path.

## Data & storage

- ~~Managed Postgres still runs `bitnamilegacy/postgresql`~~ — done (B5):
  `pgvector/pgvector:pg17` (official `postgres` + pgvector) under swarmy's own
  boot layer (`@swarmy/core` manageddb-pg); caches/sentinels on official Valkey/Redis.
- Managed-DB placement ignores the `swarmy.node.database` role label
  (`manageddb-reconcile.ts` places by region only).
- Live-verify the held-failover path on a real geo cluster (kill the primary
  mid-write; confirm the Data-tab window, then promote) and persist the LSN
  watermark across controller restarts (today a restart ⇒ unknown ⇒ hold).
- Garage presigned URLs sign the in-swarm endpoint; add a public S3 endpoint
  setting.
- Registry GC is node-local only; registry manifests/blobs are never deleted, so
  the registry volume only grows.

## Mesh

- `managed-by-swarmy` is a mode value only — swarmy doesn't stand up its own
  NetBird server yet (designed in `epic-self-hosted-mesh-and-fleets.md`).
- Direct-connect TTL: `expiresAt` is recorded but nothing sweeps expired routes.
- MTU isn't managed (WireGuard under VXLAN can fragment/drop large packets).
- The NetBird client image floats on `:latest` (covered by
  `epic-platform-upgrades.md`).
- The NetBird control-plane client still needs one live verification pass.

## Observability

- The collector is OTLP-only: no `filelog` stdout tailing (so uninstrumented
  images show no logs), no tail sampling, no gateway tier —
  `docs/product/observability.md` describes all three as the direction.

## REST API & Terraform

- `Deprecation`/`Sunset` headers and `x-swarmy-deprecated` for v1 endpoints
  (the policy is in `skill("rest-api-surface")` invariant 8).
- Terraform provider: treat async (202) deploys as blocking — poll
  `/deployments/{id}` to a terminal phase and fail the apply on failure; add
  `join_token`, `ingress` and `node` resources.

## Dashboard

(Board-by-board status and what's deferred: `redesign-build.md`.)

- Switching org can show the previous org for up to 60 s (Better Auth
  `cookieCache` isn't refreshed by `switchOrg`).
- `/services/new` has no admin override for guardrail blocks, and the REST
  `POST /services` 412 isn't in the OpenAPI spec.

## CI & release

- The Release workflow is manual until launch; restore `push: branches: [main]`
  afterwards.
- DCO sign-off is documented in `CONTRIBUTING.md` but not enforced.
- Only the root `package.json` carries a `license` field; no `NOTICE` file.

## Deferred (not blocking launch)

- More tunnel providers (ngrok, tailscale-funnel); the connector enum reserves
  them.
- Active-active Postgres logical-replication wiring (the direction prefers a
  single writer).
- macOS/Windows agent targets beyond a darwin dev build.
