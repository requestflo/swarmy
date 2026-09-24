# swarmy

**Your own cloud, on your own hardware.** A self-hosted mini-cloud platform for
VPSs, home servers, office boxes, and bare metal. Docker Swarm is the substrate;
swarmy adds the cloud-shaped layers — private mesh, a public edge, tunnels,
managed data, geo-DNS, CI/registry, backups/DR, observability, and governance —
without a required swarmy cloud. The first node bootstraps everything.

Every layer is **pluggable**, and the ones a fresh install needs to be useful
are **on by default**: the Caddy edge (HTTPS for your apps), nightly database
backups once you add a destination, and container exec in the web terminal.
Everything else — mesh, geo-DNS, CI, observability — stays off until you turn it
on. Docker remains the source of truth — if swarmy vanished tomorrow, stacks
keep running on plain `docker stack deploy`.

```
        ┌──────────────┐         wss://…/agent/ws          ┌───────────────┐
        │  dashboard   │  ◀── tRPC ──▶  ┌──────────┐  ◀──────│  agent (node) │
        │  apps/app    │                │ apps/api │         │  host binary  │
        └──────────────┘                │ gateway  │  ◀──────│  or container │
                                        └──────────┘         │  docker.sock  │
                                          ▲   ▲              └───────────────┘
                                    SQLite│   │Better Auth      (one per node)
                                (embedded)
```

The controller never touches a node's Docker socket. Each node runs an **agent**
that dials *out* over an authenticated WebSocket, streams stats + inventory, and
executes typed commands. Agents prefer a host-level binary (systemd) so the thing
that repairs the platform does not depend on Docker being healthy; a container
backend remains the fallback (node #1, enrolled by the installer, runs the
agent as a container).

A public REST API (OpenAPI) and generated SDKs (TypeScript, Python, Go) + a
Terraform provider ride the same org-scoped service layer as the dashboard.

## Install

On a fresh Linux server (Ubuntu/Debian; Docker is installed for you if missing):

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh | sudo bash
```

It installs Docker, initialises a one-node swarm, deploys the controller (it
serves the dashboard too), and enrols the machine as node #1. At the end it
prints the dashboard URL (`http://<host-ip>:3021`), your login (plus the
password, if it generated one), and an **Add a node** one-liner. Re-running it
is safe: it converges instead of duplicating.

Useful flags (pass them after `bash -s --` when piping; `bash scripts/install-swarmy.sh --help`
in a checkout lists every flag and env var):

| Flag | Does |
|---|---|
| `--non-interactive` | Never prompt; use flags / env / defaults |
| `--admin-email <e>` / `--admin-password <p>` | The owner login (password is generated if unset) |
| `--allow-signup` | Open self-registration (default: invite-only) |
| `--port <n>` | Dashboard/API port (default `3021`) |
| `--image <ref>` / `--agent-image <ref>` | Controller / agent image (default `ghcr.io/requestflo/swarmy-{controller,agent}:latest`) |
| `--check` | Preflight only — detect and report, change nothing |
| `--uninstall` | Remove the stack, secrets and node #1 agent (volumes and `state.env` are kept) |

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh \
  | sudo bash -s -- --non-interactive --admin-email you@example.com
```

A `curl | bash` install fetches its stack file from the same ref; set
`SWARMY_REF=<tag-or-branch>` (or `SWARMY_RAW_BASE=<url>`) to install from
something other than `main`.

Then, in the dashboard:

1. **Add a node** (**Nodes → Add a node**): paste the one-liner it shows, as
   root, on any other Linux box. The same one-liner repairs a node that has gone
   dark. The one printed by the installer works for 24 hours / 5 nodes; after
   that, mint one in the dashboard.
2. **Deploy**: a blueprint, a compose file, or a single image.
3. **Add a domain**: point DNS at the edge node (a manager — node #1 — by
   default; or use `app.<ip-with-dashes>.sslip.io`) and swarmy's Caddy edge — on by default — serves it over HTTPS. Public names
   get a Let's Encrypt certificate; private ones (`.local`, `.lan`, `.internal`,
   private IPs, sslip.io/nip.io names for a private IP) get Caddy's local CA, so
   your browser warns once.

New here? [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) walks the first
ten minutes end to end; [`docs/UPGRADING.md`](./docs/UPGRADING.md) covers
upgrades.

### Defaults worth knowing

- **Invite-only sign-up.** Only the seeded owner and people an admin invites
  (**Settings → Members → Invite member** hands you a copy-link) can create
  accounts; the login page hides "Sign up". To allow open self-registration set
  `SWARMY_ALLOW_SIGNUP=true` (installer: `--allow-signup`) on the controller.
  Dev (`bun dev`, non-production) allows sign-up unless
  `SWARMY_ALLOW_SIGNUP=false`.
- **Nightly database backups.** Once a backup destination exists, managed
  Postgres gets a nightly `pg_dump` and compose/blueprint databases on a named
  volume get a nightly volume backup (keep 7). No destination: the stack shows
  "backups are off" and deploys carry on.
- **Terminal.** Container exec works out of the box (RBAC-gated, audited,
  recorded). A root shell on the host is off per node until an admin turns on
  **Host shell** on that node.
- **Registry.** The in-swarm registry is opt-in; enabling it generates a login,
  and every swarmy push/pull uses it.
- **Login rate limits** are per real client IP. Behind your own reverse proxy,
  list it in `SWARMY_TRUSTED_PROXIES` so `X-Forwarded-For` is believed.

> **Back up `/var/lib/swarmy/install/state.env`.** It holds `SWARMY_SECRET_KEY`;
> lose it and every stored credential is unrecoverable.

## What it covers

| Area | Capabilities |
|---|---|
| **Compute** | Node onboarding (join tokens + install profiles), live service canvas, stack GUI builder, compose round-trip, web terminal/exec |
| **Edge** | Pluggable ingress (`caddy` default, `traefik`, `nginx`, `haproxy`, `cloudflared`, or `none`), auto-HTTPS, Cloudflare Tunnel, region-aware routing, exposure modes |
| **DNS** | Authoritative geo-DNS (`apps/dns`) with GeoIP / ECS nearest-region steering |
| **Mesh** | Zero-trust private network — drivers: NetBird, Headscale, Tailscale, WireGuard, or `none` |
| **Data** | Managed Postgres (HA topologies + PITR), Valkey/Redis cache, search, vectors, Garage object storage |
| **CI/CD** | Build on your nodes, in-swarm registry, image scans/signing policy, GC, PR previews, canary releases |
| **Ops** | OTEL → ClickHouse observability, alerts / incidents / status pages, restic backups (nightly DB backups by default) + controller self-backup, resilience score |
| **Automation** | Queues (over managed cache), scheduled jobs, workflows, inbound/outbound webhooks |
| **Governance** | Orgs + SSO, ABAC policies, guardrails admission, secrets/config families, audit log, cost/capacity |
| **AI** | Optional org AI gateway with virtual keys and usage accounting |

Product thinking lives in [`docs/product/`](./docs/product/) (start at
[`product-shape.md`](./docs/product/product-shape.md)). What's still open between
vision and code is tracked in [`plans/ROADMAP.md`](./plans/ROADMAP.md).

## Stack

| Layer | Pick |
|---|---|
| Runtime + package manager | Bun (`bun@1.3.10`) |
| Monorepo | Turborepo |
| Language | TypeScript (strict, bundler resolution) |
| UI | React 19, Vite, TanStack Router, Tailwind CSS 4, Radix + shadcn |
| API | tRPC v11 over Hono (Bun); REST via `@hono/zod-openapi` |
| DB | Prisma 7 + embedded SQLite (`bun:sqlite`; `control.db` + `telemetry.db`) |
| Auth | Better Auth (organization plugin) + ABAC (`@swarmy/abac`) |
| Validation | Zod |

## Workspaces

```
apps/
  web      Marketing site
  app      Dashboard SPA              (:3023 → proxies /api, /agent → :3021)
  api      Controller                 (Hono + tRPC + REST + agent WS + workers, :3021)
  agent    Node agent                 (host binary or container; dockerode)
  dns      Authoritative geo-DNS      (UDP/TCP nameserver)
  e2e      Playwright smoke tests
packages/
  core     Shared types, Zod protocol, compose, dockerode wrapper
  db       Prisma schema + client (embedded SQLite)
  auth     Better Auth server/client
  abac     Attribute-based access control (JSON / Cedar)
  ingress  Pluggable ingress drivers
  mesh     Pluggable mesh drivers
  dns      Geo-DNS library (steering, wire format)
  trpc     Routers, services, agent-command hub
  api-rest Public REST surface + committed openapi.json
  ui       Tailwind 4 + shadcn component library
sdks/                  TypeScript, Python, Go clients (from OpenAPI)
terraform-provider-swarmy/
```

## Develop

```bash
bun install
cp .env.example .env   # set BETTER_AUTH_SECRET (openssl rand -base64 32)
bun db:generate        # generate the Prisma clients
bun dev                # api (:3021) + app (:3023)
```

No database server. The controller's store is two SQLite files in
`.swarmy/data/` (gitignored; `SWARMY_DATA_DIR` moves them), created and migrated
on boot. Delete `.swarmy/data` to start from an empty database.

Open http://localhost:3023, create an account, then mint a join token
(**Nodes → Add a node**, or **Settings → Join tokens**). On each node:

```bash
# Dev: run the agent from source
SWARMY_JOIN_TOKEN=swt_… AGENT_WS_URL=ws://controller:3021/agent/ws bun apps/agent/src/main.ts

# Or use the install script / prebuilt binary / agent container
# (see apps/api install routes and apps/agent/Dockerfile)
```

The agent binary is also an operator CLI/TUI: `swarmy-agent` (no args) opens an
on-box diagnostics dashboard, and `swarmy-agent doctor` / `status` / `backup` /
`rejoin` / `reconnect` cover node health and recovery. If a node won't come back
online, re-run the same install one-liner (it repairs in place) or click
**Repair this node** in the dashboard — see
[`docs/NODE-RECOVERY.md`](./docs/NODE-RECOVERY.md).

## Scripts

| Command | Does |
|---|---|
| `bun dev` | Run controller + dashboard (Turbo) |
| `bun dev:web` | Run the marketing site |
| `bun dev:agent` | Run a local agent against the dev controller |
| `bun build` | Build every workspace |
| `bun typecheck` / `bun test` | Type-check / test the graph |
| `bun db:migration <name>` | Write the next migration from the schema diff (`--telemetry` for `telemetry.db`) |
| `bun db:check` | CI gate: migrations apply and match the schema |
| `bun db:studio` | Prisma Studio on `control.db` |
| `bun docker:up` / `bun docker:down` | Optional ingress test services only (Caddy + Traefik, `ingress` profile in `docker/docker-compose.yml`); the controller needs none |
| `bun openapi:dump` / `bun gen:sdks` | Refresh OpenAPI + SDKs |
| `bun build:agent-bin` | Compile linux-x64/arm64 agent binaries (CLI/TUI included) |

## Pluggable by design

**Ingress** — per org pick `caddy` (the default for new orgs), `traefik`,
`nginx`, `haproxy`, `cloudflared`, or `none`. With `none`, swarmy records
domains for display but writes **no** routing config. New drivers implement `IngressDriver` in
`@swarmy/ingress`.

**Mesh** — `none` by default; enable NetBird / Headscale / Tailscale / WireGuard
when you want private cross-node (and cross-cloud) connectivity. New drivers
implement `MeshDriver` in `@swarmy/mesh`.

**Docker is truth** — runtime intent lives in Swarm labels and objects where
possible. The controller DB holds swarmy's own identity, access, schedules, and
audit — not a shadow copy of your cluster.

## Docs & roadmap

| Doc | What |
|---|---|
| [`docs/product/`](./docs/product/) | Product vision and area design ("why") |
| [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md) · [`docs/UPGRADING.md`](./docs/UPGRADING.md) | Your first 10 minutes; upgrading a self-host install |
| [`docs/LOCAL-SWARM.md`](./docs/LOCAL-SWARM.md) · [`docs/NODE-RECOVERY.md`](./docs/NODE-RECOVERY.md) | Operator runbooks — run a local swarm; recover a node |
| [`SECURITY.md`](./SECURITY.md) | Reporting a vulnerability; secure defaults |
| [`plans/ROADMAP.md`](./plans/ROADMAP.md) | What's still open — code vs direction |
| [`plans/`](./plans/) | Active design plans (platform upgrades, dashboard redesign) |
| [`.claude/skills/`](./.claude/skills/) | Implementation invariants for contributors |

## License

[Functional Source License (FSL-1.1-ALv2)](./LICENSE.md) — use it for almost
anything, including commercially; you just can't resell swarmy as a competing
managed service. Each release converts to Apache-2.0 after two years.
