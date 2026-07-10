# swarmy

**Your own cloud, on your own hardware.** A self-hosted mini-cloud platform for
VPSs, home servers, office boxes, and bare metal. Docker Swarm is the substrate;
swarmy adds the cloud-shaped layers — private mesh, a public edge, tunnels,
managed data, geo-DNS, CI/registry, backups/DR, observability, and governance —
without a required swarmy cloud. The first node bootstraps everything.

Features are **off by default and pluggable**. Turn pieces on when you want the
convenience; drive Docker yourself when you don't. Docker remains the source of
truth — if swarmy vanished tomorrow, stacks keep running on plain
`docker stack deploy`.

```
        ┌──────────────┐         wss://…/agent/ws          ┌───────────────┐
        │  dashboard   │  ◀── tRPC ──▶  ┌──────────┐  ◀──────│  agent (node) │
        │  apps/app    │                │ apps/api │         │  host binary  │
        └──────────────┘                │ gateway  │  ◀──────│  or container │
                                        └──────────┘         │  docker.sock  │
                                          ▲   ▲              └───────────────┘
                                  Postgres│   │Better Auth      (one per node)
                                  (or PGlite)
```

The controller never touches a node's Docker socket. Each node runs an **agent**
that dials *out* over an authenticated WebSocket, streams stats + inventory, and
executes typed commands. Agents prefer a host-level binary (systemd) so the thing
that repairs the platform does not depend on Docker being healthy; a container
backend remains the fallback.

A public REST API (OpenAPI) and generated SDKs (TypeScript, Python, Go) + a
Terraform provider ride the same org-scoped service layer as the dashboard.

## What it covers

| Area | Capabilities |
|---|---|
| **Compute** | Node onboarding (join tokens + install profiles), live service canvas, stack GUI builder, compose round-trip, web terminal/exec |
| **Edge** | Pluggable ingress (`caddy` default, `traefik`, `nginx`, `haproxy`, `cloudflared`, or `none`), auto-HTTPS, Cloudflare Tunnel, region-aware routing, exposure modes |
| **DNS** | Authoritative geo-DNS (`apps/dns`) with GeoIP / ECS nearest-region steering |
| **Mesh** | Zero-trust private network — drivers: NetBird, Headscale, Tailscale, WireGuard, or `none` |
| **Data** | Managed Postgres (HA topologies + PITR), Valkey/Redis cache, search, vectors, Garage object storage |
| **CI/CD** | Build on your nodes, in-swarm registry, image scans/signing policy, GC, PR previews, canary releases |
| **Ops** | OTEL → ClickHouse observability, alerts / incidents / status pages, restic backups + controller self-backup, resilience score |
| **Automation** | Queues (over managed cache), scheduled jobs, workflows, inbound/outbound webhooks |
| **Governance** | Orgs + SSO, ABAC policies, guardrails admission, secrets/config families, audit log, cost/capacity |
| **AI** | Optional org AI gateway with virtual keys and usage accounting |

Product thinking lives in [`docs/product/`](./docs/product/) (start at
[`product-shape.md`](./docs/product/product-shape.md)). The delta between vision
and code is tracked in [`plans/roadmap-mini-cloud.md`](./plans/roadmap-mini-cloud.md).

## Stack

| Layer | Pick |
|---|---|
| Runtime + package manager | Bun (`bun@1.3.10`) |
| Monorepo | Turborepo |
| Language | TypeScript (strict, bundler resolution) |
| UI | React 19, Vite, TanStack Router, Tailwind CSS 4, Radix + shadcn |
| API | tRPC v11 over Hono (Bun); REST via `@hono/zod-openapi` |
| DB | Prisma 7 + Postgres, or embedded PGlite for lite mode |
| Auth | Better Auth (organization plugin) + ABAC (`@swarmy/abac`) |
| Validation | Zod |

## Workspaces

```
apps/
  web      Marketing site
  app      Dashboard SPA              (:3003 → proxies /api, /agent → :3001)
  api      Controller                 (Hono + tRPC + REST + agent WS + workers, :3001)
  agent    Node agent                 (host binary or container; dockerode)
  dns      Authoritative geo-DNS      (UDP/TCP nameserver)
  e2e      Playwright smoke tests
packages/
  core     Shared types, Zod protocol, compose, dockerode wrapper
  db       Prisma schema + client (Postgres / PGlite)
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

## Quick start

```bash
bun install
cp .env.example .env   # set BETTER_AUTH_SECRET (openssl rand -base64 32)
bun docker:up          # Postgres on :5678 (or use SWARMY_DB_DRIVER=pglite for zero deps)
bun db:generate        # generate Prisma client
bun db:push            # create the schema
bun dev                # api (:3001) + app (:3003)
```

> **Port 5678 already taken?** Set `SWARMY_DB_PORT` in `.env` to a free port
> (e.g. `5679`) and change the port in `DATABASE_URL` to match. `bun docker:up`
> and the Prisma helpers both read `.env`, so everything follows automatically.

Open http://localhost:3003, create an account, then mint a join token
(**Nodes → Add node**, or Settings). On each node:

```bash
# Dev: run the agent from source
SWARMY_JOIN_TOKEN=swt_… AGENT_WS_URL=ws://controller:3001/agent/ws bun apps/agent/src/main.ts

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
| `bun db:push` / `bun db:migrate` / `bun db:studio` | Prisma helpers |
| `bun docker:up` / `bun docker:down` | Local Postgres |
| `bun openapi:dump` / `bun gen:sdks` | Refresh OpenAPI + SDKs |
| `bun build:agent-bin` | Compile linux-x64/arm64 agent binaries (CLI/TUI included) |

## Pluggable by design

**Ingress** — per org pick `caddy`, `traefik`, `nginx`, `haproxy`, `cloudflared`,
or `none`. With `none` (the default), swarmy records domains for display but
writes **no** routing config. New drivers implement `IngressDriver` in
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
| [`docs/LOCAL-SWARM.md`](./docs/LOCAL-SWARM.md) · [`docs/NODE-RECOVERY.md`](./docs/NODE-RECOVERY.md) | Operator runbooks — run a local swarm; recover a node |
| [`plans/roadmap-mini-cloud.md`](./plans/roadmap-mini-cloud.md) | Governing roadmap — code vs direction |
| [`plans/`](./plans/) | Epic design docs and platform buildout notes |
| [`.claude/skills/`](./.claude/skills/) | Implementation invariants for contributors |

## License

[Functional Source License (FSL-1.1-ALv2)](./LICENSE.md) — use it for almost
anything, including commercially; you just can't resell swarmy as a competing
managed service. Each release converts to Apache-2.0 after two years.
