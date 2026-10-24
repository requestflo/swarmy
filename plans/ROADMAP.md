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

- A Heroku importer. M.
- ~~Environments~~ (clone as a new environment, shared-vs-override variables)
  and ~~Gitea / Forgejo~~ — shipped 2026-10-24. A cloned environment can't be
  removed from the dashboard yet.
- ~~Route basic-auth~~ — shipped 2026-10-24 ("Require a password" on a route;
  bcrypt hashes sealed in the ingress swarm-kv document, never on a label).

## Launch verification

- **DigitalOcean multi-region re-sweep**: 3 droplets / 2 regions — the swarm
  routing mesh (see `issues/swarm-routing-mesh-unreachable-in-lima-vm.md`), real
  public-IP ingress + ACME, and geo-DNS answering per region. Local Lima
  verification passed on 2026-09-22/23.
- Things built 2026-10-23/24 that only a real swarm can prove (each has unit or
  golden tests): the mesh MTU numbers (overlays at 1280 → containers 1230 /
  1204 encrypted), expired people grants leaving a live NetBird, Headscale's
  relayed state from `tailscale status --json`, the registry read-only GC
  window, cache policy from a Swarm label template, bucket CORS/lifecycle on a
  live Garage (v1 refuses `*.domain` origins), and the NetBird control-plane
  client (one live pass still owed).
- Open issues: `issues/manual-recovery-required-not-magical.md`,
  `issues/swarm-routing-mesh-unreachable-in-lima-vm.md`,
  `issues/vm-disk-chronically-full.md`.

## Security & governance

- SAML SSO rows are stored but skipped at build time (no SAML plugin in the
  Better Auth version in use).
- Open question: a second, agent-side factor for privileged capabilities (node
  shell, mesh, builds), so a compromised controller alone can't use them.
- Viewer / Developer roles (board 48 shows them) — an owner decision; today's
  roles are owner · admin · member plus per-app grants.
- The 2026-09 security review is closed except M13 (terminal access to
  services that mount secrets — a product decision) and M16 (registry
  credentials on the unencrypted routing mesh) — `security-review-2026-09.md`.
- Done 2026-10-24: every config-level and remaining role-gated delete runs the
  policy gate; agent ↔ controller version skew is judged on register; the
  config preview seals tunnel tokens and credentials (it returned them to any
  member).

## Edge & exposure

- `route.driver` works at render time but has no UI (API and label only).
- The installer's own dashboard domain still uses sslip.io (the auto-address
  base is configurable since 2026-10-24, `SWARMY_AUTO_ADDRESS_BASE`).
- Verify the `edge-per-node` topology on a real multi-node swarm now that the
  Caddyfile is written inside the task rather than to a host path.

## Data & storage

- Live-verify the held-failover path on a real geo cluster (kill the primary
  mid-write; confirm the Data-tab window, then promote). The LSN watermark now
  survives a short controller restart; a long outage or a moved controller
  still holds.
- Done 2026-10-24: the PITR window is read before anything changes (new
  `db.pitrWindow` agent command, sent only to agents that advertise it), also
  for restore-as-a-copy. Decide whether it sits behind `SWARMY_ALLOW_EXEC`.
- Controller store (docker-native P3): replication lag is measured now (it read
  0 even with Garage down) and a Resilience check warns. The drain and
  partition drills are scripted in the cluster e2e, unrun. Decide: the fence is
  52 s (QA-022 doubled the lease) vs the plan's 30 s; and whether enabling
  Garage also turns on replication (today a separate click).
- Done 2026-10-24: database-role placement, cache eviction/persistence
  settings, bucket CORS + lifecycle, the public S3 endpoint for presigned
  links, registry-side GC (keep-last-N mode), restore-as-a-copy creating its
  own cluster, a safety backup before every in-place restore.

## Mesh

- Self-hosted NetBird (M1/M2) is built; M3 landed 2026-10-24 (relays on edges,
  peer login expiry from the org setting — the bootstrap had reset it to 12 h
  every 5 min — and a client download mirror). Still open: the move drill, a
  raft-backed lease for the control plane (a returning old node runs up to one
  30 s tick), a brand-new node's first client pull from GHCR, and the 1 GB
  re-measure on DO. Decide whether the ~117 MB client mirror ships by default
  (`SWARMY_BUNDLE_NETBIRD_CLIENTS=0` turns it off).
- MTU: swarmy checks and explains; it can't safely recreate existing networks,
  so the fix is a manual step shown on Mesh settings.

## Observability

- No gateway tier yet (`docs/product/observability.md` describes it). Container
  stdout logs ship since 2026-10-24 (opt-in per org: a per-node `filelog`
  agent); verify Swarm passes the `labels=` log option through on a real swarm.

## REST API & Terraform

- `swarmy_ingress` needs an `updateIngressSettings` service first (each
  `ingress.*` setter re-converges the edge on its own).
- Done 2026-10-24 (later): `PATCH /services/{id}` (Terraform image changes
  apply), join tokens over REST + `swarmy_join_token`, Go/Python SDK methods.
- Done 2026-10-24: deprecation signalling, connections over REST, the
  guardrail 412 in the spec, blocking Terraform deploys, `swarmy_node`.

## Dashboard

(Board-by-board status and what's deferred: `redesign-build.md`.)

- Writing to git from the dashboard (commit swarmy.yaml, open a PR) — an owner
  decision: the GitHub App would need `contents: write` and
  `pull_requests: write`, and existing installations must re-approve. It blocks
  every "Open PR" / "Commit" on the boards.

## CI & release

- The nightly **E2E cluster** (dind, 3 nodes) has failed every night on `main`
  since at least 2026-09-25: everything that crosses nodes (templates, short-name
  DNS, pg_dump to another node, reschedule, controller move) fails while
  install/login/servers pass. Being investigated.
- Offline upgrade bundles shipped 2026-10-24 (upload on Settings › Platform,
  manual `bundle.yml`); `install-swarmy.sh --bundle` for a fresh air-gapped
  install is not built. The M16 forwarder pulls Caddy on every node, so an
  air-gapped install must preload it.

- The Release workflow is manual until launch; restore `push: branches: [main]`
  afterwards.
- DCO sign-off: an enforcing workflow is ready on its own branch, unmerged —
  existing commits carry no `Signed-off-by`, so turning it on means a
  `git rebase --signoff` the owner makes.

## Deferred (not blocking launch)

- More tunnel providers (ngrok, tailscale-funnel); the connector enum reserves
  them.
- Active-active Postgres logical-replication wiring (the direction prefers a
  single writer).
- macOS/Windows agent targets beyond a darwin dev build.
