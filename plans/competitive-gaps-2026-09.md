# Competitive gaps, 2026-09: what Dokploy and friends have that swarmy lacks

Status: **analysis, 2026-09-24.** Competitor facts come from their docs,
GitHub repos, changelogs and release pages, all read on 2026-09-24 (sources
at the bottom). Every swarmy "have" below was checked in the code on the same
date, not just in `docs/product/`. Where the docs and the code disagree, the
matrix follows the code.

**The question:** what fundamentals does a novice self-hoster get from
Dokploy or Coolify that swarmy does not have yet?

**Short answer:** swarmy's platform layer is far ahead: HA data, DR, the
edge, governance and observability. The gaps are almost all in **the first 30
minutes**:

- getting code from a repo onto a URL without writing a Dockerfile;
- connecting GitHub by clicking, not by pasting a webhook secret;
- getting a working URL before you own a domain;
- having more than nine things in the catalogue;
- getting a Discord ping when a deploy fails.

Those are exactly the moments where a Dokploy or Coolify user decides to stay.

## (a) Feature matrix

✓ = first-class · ◐ = partial or with caveats (see footnote) · ✗ = missing.

In the swarmy column, ✓ means the feature exists in code today. Competitor
cells describe the self-hosted open-source edition unless marked (EE/paid).

| Capability | swarmy | Dokploy | Coolify | CapRover | Easypanel | Dokku | Kamal | Railway | Render |
|---|---|---|---|---|---|---|---|---|---|
| **Deploy and build** | | | | | | | | | |
| Git: GitHub + GitLab | ◐¹ | ✓ | ✓ | ◐ | ◐ | ◐ | ✗ | ✓ | ✓ |
| Git: Bitbucket / Gitea / self-hosted | ✗ | ✓ | ✓ | ◐ | ◐ (SSH) | ✓ | ✗ | ✗ | ✓ |
| GitHub App / OAuth repo picker | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| Dockerfile builds | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Zero-config builds (Nixpacks / Railpack / buildpacks) | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ | ◐ (CNB) | ✓ | ✓ |
| Docker Compose deploy | ✓² | ✓ | ✓ | ◐ | ✓ | ✗ | ✗ | ◐ | ◐ |
| Lossless compose export (no lock-in) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ |
| Monorepo (context dir + watch paths) | ◐³ | ✓ | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ |
| Persistent build cache | ✗⁴ | ◐ | ✓ | ◐ | ◐ | ✓ | ✓ | ◐ | ✓ |
| Remote / dedicated build servers | ✓ (Builder role) | ✓ | ✓ | ✗ | ◐ | ✗ | ✓ | n/a | n/a |
| Built-in registry | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ◐ | n/a | n/a |
| Third-party private registry creds (GHCR, Docker Hub) | ✗⁵ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| One-click templates (count) | ◐ 9 | ✓ 532 | ✓ 368 | ✓ 358 | ✓ 750+ | ✗ | ✗ | ✓ 2k+ | ◐ |
| PR preview environments | ✓ | ◐ (GitHub, no compose) | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Preview URL / commit status posted to the PR | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Preview with a copy of the data | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ | ✗ (empty) |
| Pre/post-deploy command (migrations) | ◐⁶ | ◐ | ✓ | ✗ | ✗ | ✓ | ✓ (hooks) | ✓ | ✓ |
| **Releases** | | | | | | | | | |
| Health-gated deploy + auto-rollback | ✓ | ◐ (raw Swarm JSON) | ◐ | ◐ | ◐ | ✓ | ✓ | ✓ | ✓ |
| One-click rollback + compose diff | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | ✓ | ✓ | ✓ |
| Canary / weighted traffic | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Replicas | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Autoscaling | ◐⁷ | ✗ | ✗ | ✗ | ✗ | ◐ (k3s+KEDA) | ✗ | ◐ | ✓ |
| Scale-to-zero | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| **Domains and edge** | | | | | | | | | |
| Auto TLS (Let's Encrypt) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ |
| Free auto-generated app URL | ✗⁸ | ◐ (HTTP only) | ✓ (sslip) | ◐ (wildcard required) | ✓ | ✗ | ✗ | ✓ | ✓ |
| Wildcard certs / DNS-01 | ◐⁹ | ◐ | ◐ | ◐ | ◐ | ✓ | ✗ | ✓ | ✓ |
| Basic-auth / password-protect an app | ✗ | ◐ | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ |
| Rate limit / IP allowlist / bot block per route | ✓ | ✗ | ◐ | ✗ | ◐ | ✗ | ✗ | ◐ | ◐ |
| Tunnels (no public IP) | ✓ (Cloudflare) | ◐ (guide) | ◐ (guide) | ✗ | ✓ | ✗ | ✗ | n/a | n/a |
| Authoritative geo-DNS + multi-region edge | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ | ◐ |
| **Data** | | | | | | | | | |
| Managed Postgres (HA, replicas, failover) | ✓ | ◐ (single) | ◐ (single) | ✗ | ◐ | ◐ | ✗ | ✓ | ✓ |
| Managed MySQL / MariaDB / Mongo | ✗¹⁰ | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Redis/Valkey, search, vector | ✓ | ◐ (redis) | ◐ | ◐ | ◐ | ✓ | ✗ | ✓ | ◐ |
| S3 object storage on your nodes | ✓ (Garage) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| DB backups to S3 + one-click restore | ✓ | ✓ | ✓ | ✗ | ✓ (paid) | ◐ | ✗ | ✓ | ✓ |
| PITR | ✓ (wal-g) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Encrypted backups | ✓ (restic) | ✗ | ◐ | ✗ | ◐ | ◐ | ✗ | ✓ | ✓ |
| Volume backups | ✓ | ✓ | ✓ | ✗ | ◐ | ✗ | ✗ | ✓ | ◐ |
| Restore drills / backup verify | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Platform self-backup (control plane) | ✓ | ✓ | ✓ | ◐ | ✗ | ◐ | n/a | n/a | n/a |
| **Run and operate** | | | | | | | | | |
| Cron / scheduled jobs | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ◐ | ✓ | ✓ |
| Queues / workers / workflows | ✓ | ✗ | ✗ | ✗ | ✗ | ◐ | ◐ | ◐ | ✓ |
| Inbound + outbound webhooks | ✓ | ◐ | ◐ | ✗ | ✗ | ✗ | ✗ | ◐ | ✓ |
| Env vars per service | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Shared / reference variables | ◐¹¹ | ✓ | ✓ | ✗ | ◐ | ✗ | ✗ | ✓ | ✓ |
| Environments (staging → prod, clone/promote) | ✗¹² | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ (destinations) | ✓ | ✓ |
| Secrets (versioned Docker secrets, rotation) | ✓ | ✓ (+ vault providers) | ◐ | ✗ | ◐ | ◐ | ✓ (adapters) | ✓ | ✓ |
| Live service + build logs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Logs for uninstrumented apps in the log store | ◐¹³ | ✗ | ◐ (drains) | ✗ | ✗ | ◐ | ◐ | ✓ | ✓ |
| Traces / service map (OTel) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ | ◐ |
| Node + container metrics | ✓ | ◐ | ◐ | ◐ (NetData) | ◐ | ✗ | ✗ | ✓ | ✓ |
| Alerts, incidents, public status page | ✓ | ◐ (thresholds) | ◐ | ✗ | ✗ | ✗ | ✗ | ◐ | ◐ |
| Notification channels | ◐¹⁴ | ✓ (12 kinds) | ✓ (7) | ◐ (Pro) | ◐ (paid) | ✗ | ✗ | ✓ | ✓ |
| Deploy/build/backup events → notifications | ◐¹⁴ | ✓ | ✓ | ◐ | ◐ | ✗ | ✗ | ✓ | ✓ |
| Automatic Docker disk cleanup | ◐¹⁵ | ◐ | ✓ | ✗ | ✓ | ◐ | ◐ | n/a | n/a |
| Web terminal (container + node, recorded) | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| **Estate** | | | | | | | | | |
| Multi-node | ✓ (Swarm + agent) | ✓ (SSH / Swarm) | ✓ (SSH) | ✓ (Swarm) | ◐ (alpha, paid) | ◐ | ✓ (SSH) | n/a | n/a |
| Nodes behind NAT (dial-out, zero inbound) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | n/a |
| WireGuard mesh across sites | ✓ | ◐ (guide) | ◐ (guide) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Provision cloud servers from the UI | ✗ | ✗ | ✓ (Hetzner, DO, Vultr) | ◐ | ✗ | ✗ | ✗ | n/a | n/a |
| One-button platform upgrade | ◐¹⁶ | ◐ | ✓ | ✓ | ✓ | ◐ | n/a | n/a | n/a |
| **Access and API** | | | | | | | | | |
| Teams + roles | ✓ | ✓ | ◐ | ✗ | ◐ (paid) | ✗ | ✗ | ✓ | ✓ |
| Fine-grained ABAC / per-resource grants | ✓ | ◐ (EE) | ✗ | ✗ | ◐ (paid) | ✗ | ✗ | ◐ | ◐ |
| OIDC SSO | ✓ | ◐ (EE) | ◐ (no generic OIDC) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| TOTP 2FA | ✗¹⁷ | ✓ | ✓ | ◐ (Pro) | ✓ | n/a | n/a | ✓ | ✓ |
| Passkeys | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ | ◐ |
| Audit log UI | ✓ | ◐ (EE) | ◐ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Guardrails / prod safety / image CVE + signing gate | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| REST API + SDKs | ✓ | ✓ | ✓ | ◐ | ✓ | ◐ (Pro) | ✗ | ✓ | ✓ |
| Official Terraform provider | ✓ | ✗ (community) | ✗ (community) | ✗ | ✗ | ✗ | ✗ | ◐ | ✓ |
| Developer CLI (deploy / logs / env pull) | ✗¹⁸ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| MCP server | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| AI gateway (model keys, metering) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Cost per stack / node | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| i18n | ✗ | ✗ | ◐ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Licence | FSL-1.1 → ALv2 | Apache + proprietary EE | Apache-2.0, all features | Apache + Pro | closed, freemium | MIT | MIT | SaaS | SaaS |

**Footnotes**

1. GitHub and GitLab only (`GitProviderKind` enum). You paste a webhook URL
   and secret into the provider, plus an optional PAT. No OAuth or App
   install, and no repo picker.
2. `docker stack deploy` semantics; `build:` keys are refused. Import and
   export are lossless.
3. The `image.build` protocol takes `context` and `dockerfile`. There are no
   watch paths or path filters on the webhook, so every push to the branch
   rebuilds.
4. Each build is a fresh `moby/buildkit:rootless` container and uses no
   `--export-cache/--import-cache`, so every build is cold.
5. `registryAuth` exists on the wire, but only the in-swarm org registry
   fills it (`registry-auth.ts`). No UI, REST route or compose field lets you
   store GHCR or Docker Hub credentials. A private GHCR image cannot be
   deployed from the dashboard.
6. Workflows can run a migration container before a step, but there is no
   "release command" on a deploy.
7. Queue-depth autoscaling (`queue-reconcile`) and scale-to-zero. No CPU,
   memory or RPS autoscaling.
8. The installer gives the dashboard `swarmy.<ip>.sslip.io`. Apps get
   nothing automatic; a user must own and point a domain. On top of that, new
   orgs default to the `none` ingress driver (open product call in the
   ROADMAP).
9. Caddy on-demand TLS covers any number of hosts (gated by `/ingress/ask`),
   and swarmy-dns is authoritative. But there is no DNS-01 or
   provider-token flow for true wildcard certs, and previews need a
   wildcard `baseDomain` pointed by hand.
10. Managed data is Postgres only (`manageddb.ts`: `engine: z.literal
    ('postgres')`). MySQL, MariaDB and Mongo in compose are auto-detected
    (`autoBackup.ts`) and get crash-consistent volume backups, not logical
    dumps, restore or HA.
11. Managed-data attach injects `DATABASE_URL` and friends, which covers the
    commonest reference-variable case. There are no org, project or
    stack-level shared variables and no `${{svc.VAR}}` references.
12. Stacks can be tagged `swarmy.env=production` for guardrails. There is no
    staging/production grouping, no "clone stack as staging", and no promote.
13. `services.logs` streams `docker service logs` live. The ClickHouse log
    store is OTLP-only; `filelog` is on the ROADMAP.
14. Channel kinds are `EMAIL | SLACK | TEAMS | WEBHOOK`: no Discord,
    Telegram, ntfy, Gotify or Pushover. Channels are wired to alert rules;
    build-failed and deploy-rolled-back reach you only through outbound
    webhooks.
15. Image GC prunes swarmy-pushed images only (`repoPrefix`-scoped). There is
    no general dangling-image, build-cache, container-log or journald hygiene;
    see `issues/vm-disk-chronically-full.md`. A `disk` alert signal exists.
16. `nodes.upgradeAgent` exists; everything else is
    `epic-platform-upgrades.md` (in progress).
17. Better Auth plugins wired: organization, magicLink, genericOAuth,
    passkey. There is no `twoFactor` plugin, and terminal `requireMfa` is not
    enforced (ROADMAP).
18. `swarmy-agent` is an on-node recovery CLI. There is no developer-facing
    CLI; the REST API and SDKs exist, so a CLI is a thin layer on top.

## (b) Fundamentals we're missing, ranked by impact on a novice choosing swarmy over Dokploy or Coolify

Impact means "would this make a first-time self-hoster bounce in the first
hour, or pick the other tool in a comparison table?" Sizes: S ≈ days, M ≈
1–2 weeks, L ≈ 3+ weeks.

### 1. Zero-config builds: Railpack auto-detect, with Nixpacks as a fallback (S–M, launch-blocker)

- **Why it matters.** The novice has a Next.js, Rails, Django or Go repo and
  no Dockerfile. Today swarmy says "Dockerfile required". Dokploy defaults to
  Nixpacks, Coolify detects with Nixpacks or Railpack, Easypanel tries
  Dockerfile → Railpack, and Railway made Railpack its default. This is the
  single biggest first-deploy failure.
- **How competitors do it.** A build-type selector (Dockerfile / Railpack /
  Nixpacks / Static), auto-picked (Dockerfile if one is present, else
  Railpack) and overridable. There is also a "publish directory" for static
  output served by nginx.
- **swarmy-shaped proposal.**
  - Extend `image.build` (`protocol/build.ts`) with an optional
    `builder: 'dockerfile' | 'railpack' | 'static'` field. The protocol only
    grows, so no `PROTOCOL_VERSION` bump.
  - Railpack emits BuildKit LLB, so it drops into the existing
    rootless-BuildKit `buildctl` path in `apps/agent/src/handlers/build.ts`
    (`railpack prepare` → `buildctl build --frontend gateway.v0` with the
    railpack frontend). Isolation and the push path stay the same.
  - `GitRepo` gains a `builder` column, auto-detected at link time.
  - Static sites use Railpack's static provider (Caddy-served).
  - Owned by the git-apps epic; the `cicd-registry` skill applies.

### 2. Connect GitHub by clicking: GitHub App + repo picker + PR feedback (M, launch-blocker)

- **Why it matters.** Linking a repo today means copying a webhook URL and
  secret into GitHub settings and minting a PAT. Every competitor with a UI
  offers "Install GitHub App → pick repo". Previews are swarmy's strength, but
  nobody sees them if the URL never shows up in the PR.
- **How competitors do it.**
  - Dokploy and Coolify register a per-instance GitHub App via the manifest
    flow. It carries the webhook, clone token and checks permission, so there
    are no PATs.
  - GitLab, Gitea and Bitbucket use OAuth apps.
  - Vercel and Railway post the preview URL as a PR comment and a
    commit/deployment status.
- **swarmy-shaped proposal.**
  - Add a `GitProviderConnection` (org-scoped, vault-encrypted App private
    key or OAuth token) using the GitHub App manifest flow, so it is
    one-click on a self-host with no swarmy cloud dependency.
  - Mint installation tokens JIT at build dispatch, following the existing
    "resolved just-in-time, never baked" rule.
  - Add a repo picker and branch dropdown in `/ci`.
  - Post a commit status and a sticky PR comment with the `pr-<N>` URL from
    `previews.service.ts`.
  - Add Gitea/Forgejo, then Bitbucket, to `GitProviderKind`.
  - Add path filters (watch paths) to the webhook handler (`apps/api/src/webhooks.ts`).

### 3. A working URL before you own a domain, and Caddy on by default (S, launch-blocker)

- **Why it matters.**
  - Coolify gives every app `<uuid>.<ip>.sslip.io`. Dokploy has
    `traefik.me`, though it is HTTP-only. Railway and Render give a platform
    subdomain.
  - Swarmy's installer already computes `swarmy.<ip>.sslip.io` for the
    dashboard, but a deployed app gets no URL.
  - With the `none` ingress default, a novice's first deploy is "running…
    where?"
- **swarmy-shaped proposal.**
  - Resolve the ROADMAP product call: default new orgs to Caddy.
  - On first deploy of any service with an HTTP port, auto-add a
    `swarmy.ingress.routes` entry `<svc>-<stack>.<ingress-ip>.sslip.io` with
    TLS auto. Public IPs get real Let's Encrypt; private IPs get the local-CA
    path that `private-host.ts` already handles.
  - It is a real route label, so it is exportable and removable.
  - Show it as the first thing on the stack canvas.
  - Behind CGNAT, offer the tunnel instead.

### 4. Private registry credentials for image deploys (S, launch-blocker)

- **Why it matters.** "Deploy `ghcr.io/me/app:1.2`" is the second most common
  first deploy. Every competitor stores registry credentials. swarmy's wire
  already carries `registryAuth`, but only the org registry fills it.
- **swarmy-shaped proposal.**
  - Add a `RegistryCredential` row (org-scoped, vault-encrypted, never
    returned).
  - Match by host prefix in the existing hub dispatch decorator
    (`registry-auth.ts`) for `service.deploy` and `image.pull`.
  - Add a "Registries" section under Settings → CI & registry, and a REST
    route with a Terraform resource.
  - Image autocomplete should use the same credentials.

### 5. The catalogue: from 9 blueprints to around 150 good ones (M, launch-blocker at ~50)

- **Why it matters.** Dokploy has 532 templates, Coolify 368, CapRover 358
  and Easypanel "750+". Swarmy has 9. "Can I one-click Plausible, Uptime
  Kuma, Immich, Supabase?" is how self-hosters shop.
- **How competitors do it.** A compose file plus a small metadata and
  variables header, in a separate repo, fetched from a CDN so the catalogue
  updates without a platform release.
- **swarmy-shaped proposal.**
  - Keep blueprints as the curated, managed-data-wired tier.
  - Add a **compose template tier** that goes through the existing lossless
    `composeToStack` path and admission.
  - Use a `templates/` repo plus a signed index, fetched by the controller
    (never the browser) and cached.
  - Write an importer for Coolify's compose templates (Apache-2.0, with
    attribution) that rewrites `SERVICE_*` magic variables into swarmy
    generated secrets and sslip routes.
  - Swarm-incompatible keys are already flagged by the importer.
  - Where a template's database can be swapped for managed Postgres
    (`inject`), offer it.

### 6. Discord, Telegram and ntfy, plus lifecycle events on channels (S, launch-blocker for Discord/Telegram)

- **Why it matters.** Self-hosters live in Discord and Telegram, and use ntfy
  or Gotify at home. Dokploy ships 12 channel kinds and Coolify 7; swarmy has
  4 (email, Slack, Teams, webhook). "Tell me when a deploy or backup fails"
  is table stakes, and today swarmy routes that only through alert rules or
  raw outbound webhooks.
- **swarmy-shaped proposal.**
  - Add `DISCORD | TELEGRAM | NTFY | GOTIFY | PUSHOVER` to
    `NotificationChannelKind`, with renderers in `notifications-send.ts`.
  - Seed default alert rules for `build-failed`, `deploy-rolled-back`,
    `backup-failed`, `cert-expiry`, `disk` and `node-offline`. The signals
    mostly exist; the build and deploy ones become events the
    alert-evaluator consumes.
  - Default them onto the first channel the user creates.

### 7. TOTP 2FA, and actually enforce `requireMfa` (S, launch-blocker)

- **Why it matters.** Both Coolify (11 critical CVEs in January 2026) and
  Dokploy (pre-auth takeover CVE-2026-45631) had rough security years. Swarmy
  can win the "safer to expose" comparison, but a panel with root on every
  node and no TOTP loses it on the first checklist. Passkeys are great, but
  users expect an authenticator app.
- **swarmy-shaped proposal.**
  - Add Better Auth's `twoFactor` plugin (TOTP plus backup codes) in
    `packages/auth/src/server.ts`.
  - Add an org policy "require 2FA for admins".
  - Enforce `TerminalPolicy.requireMfa` and `maxSessionMs` at
    `terminal.open`.
  - Add a controller-side reset runbook to `swarmy-agent`.

### 8. Server hygiene on by default: Docker cleanup and disk-threshold alerts (S, launch-blocker)

- **Why it matters.** Full disks are the number-one "mystery" failure on a
  single VPS. Swarmy's own test VMs hit it repeatedly
  (`issues/vm-disk-chronically-full.md`). Coolify and Easypanel schedule
  Docker cleanup and alert on disk thresholds.
- **swarmy-shaped proposal.**
  - Extend `image.prune` (agent `prune.ts`) with a `hygiene` mode: dangling
    images, stopped non-swarm containers and BuildKit cache over N GB.
    Pinned in-prod digests stay untouchable, as the existing invariant
    requires.
  - Have the installer set the Docker `json-file` `max-size`/`max-file`
    log-opts and a journald cap.
  - Make a default `disk > 85%` alert rule.
  - Add a disk check to `swarmy-agent doctor`.
  - Give the resilience score a "disk headroom" factor.

### 9. Managed MySQL/MariaDB and MongoDB, at least with logical backup and restore (M, partial launch-blocker)

- **Why it matters.** WordPress, Ghost-on-MySQL, many PHP apps and Mongo
  stacks are a huge share of self-host installs. Dokploy, Coolify and
  Easypanel list all three as first-class databases with engine-aware dumps
  and UI restore. Swarmy's crash-consistent volume backup is honest, but it
  isn't "Restore" in the UI.
- **swarmy-shaped proposal.**
  - Phase 1 (launch):
    - Engine-aware logical backups for detected `mysql`/`mariadb`/`mongo`
      compose services. `autoBackup.ts` already detects them.
    - `mysqldump`/`mariadb-dump`/`mongodump` as a `container.runOnce`
      sidecar into the same restic catalog.
    - A one-click restore that reuses the `dbBackup` restore modes
      (clone-to-new, in-place).
  - Phase 2: a `swarmy.db.engine=mysql` single/primary-replica topology in
    `manageddb-reconcile`.

### 10. Environments and shared variables: clone a stack as staging, reference variables (M–L, not a blocker)

- **Why it matters.**
  - Dokploy and Coolify both model Project → Environment, with project and
    environment-scoped shared variables (`${{project.X}}`).
  - Railway's reference variables and environment sync are the DX bar.
  - A novice wants "staging and prod of the same app" and "set
    `STRIPE_KEY` once".
- **swarmy-shaped proposal.**
  - An environment is a Docker label (`swarmy.environment=<name>`) plus a
    `swarmy.app=<name>` grouping label on stacks. That is Docker truth, with
    no new table beyond an optional display row.
  - "Clone as staging" copies `composeSource` with a name suffix, a fresh
    route, and optionally a DB fork from the latest backup (see #11).
  - "Promote" redeploys staging's resolved image digests into prod as a
    Release. It is digest-pinned, so there is no rebuild.
  - Shared variables are an org or app `EnvGroup` (vault-encrypted), resolved
    at deploy into the ServiceSpec env and recorded on the Release. Add
    `${{svc.VAR}}` interpolation in the compose importer.
  - Bulk `.env` paste in the builder is a cheap first slice. **Do the bulk
    paste for launch.**

### Just below the top 10

- **11. Preview environments with data (M).** Fork the managed Postgres from
  the latest backup into each `pr-<N>` stack. The restore-drill machinery
  (`resilience.service` clone to a throwaway cluster) already does 90% of
  this. No self-hosted competitor has it, and Vercel/Neon and Netlify made it
  the top-end bar. It would be a signature feature, not catching up.
- **12. Developer CLI and an MCP server (M).**
  - A `swarmy` CLI over the REST SDK: `deploy`, `logs`, `env pull`, `run`,
    `open`.
  - An MCP server exposing the REST API (read-only by default, with
    ABAC-scoped API keys).
  - Dokploy, Coolify and Easypanel all shipped MCP in 2026, and all the
    hosted players have it.
- **13. Persistent build cache (S).** Keep a per-builder-node BuildKit state
  volume, or `--export-cache type=registry` to the in-swarm registry. Pull
  the `SOURCE_COMMIT` trick from Coolify so layers are reused.
- **14. Release command (pre-deploy migrations) (S).** Add a `preDeploy`
  one-shot on the stack (label `swarmy.deploy.pre`), run via
  `container.runOnce` with the new image before the swap. A failure aborts
  the release.
- **15. Password-protect a route (S).** Add a basic-auth policy to ingress
  route protections (Caddy `basic_auth`), and optionally a forward-auth gate
  against swarmy's own Better Auth. That is "protect my preview or admin
  panel", which Dokploy only offers as EE.
- **16. Wildcard via DNS-01 (S–M).** For zones on swarmy-dns, swarmy is the
  authoritative server, so DNS-01 needs no third-party token. That makes
  `*.preview.example.com` and the previews `baseDomain` automatic.
  Cloudflare and Route53 tokens come next.
- **17. Import from Coolify, Dokploy or Heroku (M, post-launch wedge).**
  Coolify is dropping Swarm in v5, Dokploy has no import/export (#1733),
  Heroku is in sustaining mode, and swarmy speaks compose natively.
- **18. Provision a server from the UI (M, post-launch).** Hetzner, DO and
  Vultr API token → create the VM with cloud-init running the existing
  join one-liner. The dial-out model makes this unusually clean.
- **19. External secret providers (M, post-launch).** Infisical, Vault and
  Doppler as sources for secret families (`secretsMgr`).

## (c) Where swarmy is already ahead

This section only lists things verified in code.

- **Safety as a product.**
  - Health-gated deploys with auto-rollback, and live canaries with weighted
    traffic and error-rate trip (`deploy-safety`, `deploy-canary`).
  - An admission pipeline: guardrails, exposure and image CVE/cosign
    gates, with audited overrides.
  - Dokploy's zero-downtime means hand-writing Swarm health JSON in
    nanoseconds. Coolify's is "not guaranteed" and absent for compose.
- **A data plane nobody self-hosted matches.**
  - HA Postgres with automatic promotion, geo read replicas, pgvector in
    place, Valkey with Sentinel, Meilisearch/Typesense, Qdrant.
  - Garage S3 on your own nodes with per-bucket access, quotas, public
    domains and website hosting.
  - Encrypted restic backups with enforced retention, wal-g PITR, and
    offsite mirroring.
- **Recovery you can rehearse.**
  - Restore, failover and backup-verify drills.
  - A resilience score with fix links.
  - DR reconciliation that restores stranded volumes onto a healthy node.
  - A passphrase-sealed controller brain that re-adopts the swarm on a fresh
    box.
  - Node recovery: self-healing one-liner, `doctor`, recovery beacon.
- **The network.**
  - The agent dials out, so nodes work behind NAT/CGNAT with zero inbound
    ports.
  - A pluggable WireGuard mesh across sites, plus audited direct-connect.
  - Authoritative geo-DNS with region-aware edge Caddy.
  - Cloudflare Tunnel as a driver, and per-route rate limit, IP rules and bot
    blocking.
  - Exposure auditing that names a Postgres publishing 5432.
- **Governance, observability and escape hatches that are free, not EE.**
  - OIDC SSO, ABAC with per-resource grants, a full audit log and a
    recorded web terminal with four-eyes approval. Dokploy gates SSO, audit
    and custom roles behind Enterprise.
  - Per-stack OTel with traces, a service map, logs, a plain-words health
    narrative, alerts → incidents → a public status page.
  - An official REST API, SDKs and a Terraform provider.
  - Lossless compose export: "delete swarmy and your stacks keep running".
  - Queues with autoscaling, workflows with approvals, and an AI gateway.

"Time travel" is not a swarmy feature. PITR is the real thing to cite.

## (d) Don't bother (or not now)

- **More ingress proxies as a selling point.** Swarmy already has 6 drivers.
  Novices want one that works, which is the Caddy default (#3).
- **Cloud spend caps and "pause production" budgets.** They exist to stop
  surprise bills from Railway or Vercel. On your own hardware, the per-node
  cost view is the right shape.
- **Serverless functions, edge functions, ISR, image CDN, skew protection.**
  These are Vercel and Netlify frontend-hosting concerns. Swarmy runs
  containers; a static site on Caddy or a Garage website bucket covers the
  self-host need.
- **Kubernetes, Nomad or k3s schedulers (Dokku, Portainer).** Swarm is the
  substrate by design.
- **Heroku buildpacks / herokuish.** Railpack covers auto-detect with a
  maintained, BuildKit-native tool. Adding CNB as well doubles the support
  surface for little gain.
- **GPU as a feature.** Fly retired GPUs on 2026-07-31. Swarm generic
  resources plus a placement label and a docs page is enough until someone
  asks.
- **A native mobile app.** The responsive shell with a mobile tab bar is
  enough; Railway's iOS app is not what wins self-hosters.
- **i18n before launch.** Dokploy (English only) and Coolify (partial) show
  it is not what wins adoption. Keep strings extractable.
- **An AI compose generator.** It's a gimmick next to a large template
  catalogue plus lossless import. Revisit via the MCP server instead.
- **White-labelling and SCIM.** These are enterprise-deal features; they can
  come after there are enterprise deals.
- **Harbor-class registry features.** This is already rejected in
  `cicd-and-registry.md`; the only real registry gap is manifest GC (on the
  ROADMAP).

One non-feature to watch: **licence perception.** Swarmy is FSL-1.1, which
becomes ALv2 after two years. Coolify's "Apache-2.0, every feature free
self-hosted" is its strongest marketing line, and Dokploy's 2025 licence
controversy cost it goodwill. Say clearly in the README and on the site that
self-hosting is free with every feature, and what FSL does and does not
forbid.

## (e) Proposed roadmap additions, in order

| # | Item | Size | Launch-blocker |
|---|---|---|---|
| 1 | Railpack zero-config builds (auto-detect, static sites) | S–M | **Yes** |
| 2 | GitHub App manifest flow + repo picker + PR comment/commit status + watch paths; Gitea next | M | **Yes** |
| 3 | Caddy by default + auto `sslip.io` URL per HTTP service | S | **Yes** |
| 4 | Third-party registry credentials (GHCR, Docker Hub, and so on) | S | **Yes** |
| 5 | Compose template catalogue (≥50 at launch, CDN-indexed, Coolify importer) | M | **Yes** (≥50) |
| 6 | Discord, Telegram and ntfy channels + default lifecycle alert rules | S | **Yes** |
| 7 | TOTP 2FA + enforce terminal `requireMfa`/`maxSessionMs` | S | **Yes** |
| 8 | Docker hygiene (prune mode, log-opts, journald cap) + default disk alert | S | **Yes** |
| 9 | MySQL/MariaDB/Mongo logical backup + one-click restore (managed engine later) | M | Partial: backup and restore **yes** |
| 10 | Bulk `.env` paste (launch), then shared env groups + environments (clone/promote) | S, then M–L | Bulk paste **yes**; the rest no |

Next after these: preview data forks (#11), CLI + MCP (#12), build cache
(#13), release command (#14), route basic-auth (#15), DNS-01 wildcard via
swarmy-dns (#16), then importers, server provisioning and secret providers.

## Sources (all accessed 2026-09-24)

**Self-hosted competitors**
- Dokploy:
  - https://github.com/Dokploy/dokploy (v0.30.7, 2026-09-18; LICENSE.MD, LICENSE_PROPRIETARY.md; issues #2028, #1733, #1404, #2579, #2926, #4008)
  - https://github.com/Dokploy/templates
  - https://github.com/Dokploy/cli
  - https://github.com/Dokploy/mcp
  - https://docs.dokploy.com/docs/core
  - https://docs.dokploy.com/docs/core/comparison
  - https://dokploy.com/pricing
  - https://github.com/Dokploy/dokploy/discussions/2476
- Coolify:
  - https://github.com/coollabsio/coolify (v4.3.23, 2026-09-18; templates/compose; lang/; issues #5685, #2378, #3226)
  - https://github.com/coollabsio/coolify-docs
  - https://github.com/coollabsio/coolify-cli
  - http://coolify.io/pricing
- CapRover:
  - https://github.com/caprover/caprover (v1.15.4, 2026-08-30)
  - https://github.com/caprover/one-click-apps
  - https://github.com/caprover/caprover-website
- Dokku:
  - https://github.com/dokku/dokku (v0.38.30, 2026-09-23)
  - https://github.com/dokku/dokku-letsencrypt
  - https://pro.dokku.com/
- Kamal:
  - https://github.com/basecamp/kamal (v2.12.0, 2026-06-18)
  - https://github.com/basecamp/kamal-site
- Easypanel:
  - https://easypanel.io/
  - https://easypanel.io/pricing
  - https://easypanel.io/changelog (2.36.0)
  - https://easypanel.io/docs/builders
  - https://easypanel.io/docs/backups
  - https://easypanel.io/docs/mcp
- Portainer:
  - https://github.com/portainer/portainer (2.45.1)
  - https://www.portainer.io/pricing
  - https://www.portainer.io/features
- Security and community:
  - https://thehackernews.com/2026/01/coolify-discloses-11-critical-flaws.html
  - https://www.sentinelone.com/vulnerability-database/cve-2026-45631/
  - https://www.thehackerwire.com/vulnerability/CVE-2026-86059/
  - https://news.ycombinator.com/item?id=47876352
  - https://news.ycombinator.com/item?id=43555996
  - https://biggo.com/news/202508171923_Dokploy_Licensing_Issues_Mixed_Reviews

**Hosted platforms (the DX bar)**
- Railway:
  - https://railway.com/features
  - https://railway.com/templates
  - https://railway.com/changelog
  - https://docs.railway.com/guides/environments
  - https://docs.railway.com/reference/deployments
  - https://docs.railway.com/guides/webhooks
  - https://docs.railway.com/reference/usage-limits
- Render:
  - https://render.com/docs
  - https://render.com/changelog
  - https://render.com/docs/preview-environments
  - https://render.com/docs/postgresql-backups
  - https://render.com/docs/scaling
  - https://render.com/docs/rollbacks
  - https://render.com/docs/mcp-server
- Fly.io:
  - https://docs.fly.io/llms.txt
  - https://docs.fly.io/mpg/
  - https://docs.fly.io/launch/autostop-autostart/
  - https://community.fly.io/t/gpu-migration-fly-io-gpus-will-be-deprecated-as-of-july-31-2026/27110
- Vercel:
  - https://vercel.com/docs
  - https://vercel.com/docs/deployments/environments
  - https://vercel.com/docs/skew-protection
  - https://vercel.com/docs/spend-management
  - https://neon.com/docs/guides/vercel-previews-integration
- Netlify:
  - https://docs.netlify.com/deploy/deploy-overview/
  - https://docs.netlify.com/build/data-and-storage/netlify-database
- Northflank:
  - https://northflank.com/features
  - https://northflank.com/changelog
  - https://northflank.com/docs/v1/application/databases-and-persistence/fork-an-addon
- Heroku:
  - https://www.heroku.com/blog/an-update-on-heroku/ (sustaining engineering from 2026-02-06)
  - https://devcenter.heroku.com/changelog
  - https://devcenter.heroku.com/articles/github-integration-review-apps
- Elestio:
  - https://elest.io/
  - https://docs.elest.io/

**swarmy code evidence** (paths are relative to the repo):
- `packages/db/prisma/schema/cicd.prisma` (`GitProviderKind`)
- `packages/core/src/protocol/build.ts`
- `apps/agent/src/handlers/build.ts`
- `packages/trpc/src/services/registry-auth.ts`
- `packages/trpc/src/services/blueprints/catalog.ts` (9 entries)
- `packages/db/prisma/schema/alerts.prisma` (`NotificationChannelKind`)
- `packages/auth/src/server.ts` (plugins)
- `packages/trpc/src/routers/manageddb.ts` (postgres-only)
- `packages/trpc/src/services/autoBackup.ts`
- `packages/trpc/src/routers/{services,stacks,cicd,buckets,resilience,offsiteMirror,cost,tunnels}.ts`
- `scripts/install-swarmy.sh` (sslip dashboard domain)
- `LICENSE.md` (FSL-1.1-ALv2)
