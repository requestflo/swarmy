# swarmy

A modern, **unopinionated** Docker Swarm controller. Manage a cluster of nodes
from a slick dashboard: live stats, service deploys, and pluggable ingress
(Caddy, Traefik, or none — you stay in control).

Think Dokploy, but it doesn't force an ingress, a build system, or a workflow on
you. Turn pieces off and drive Docker yourself; turn them on when you want the
convenience.

```
        ┌──────────────┐         wss://…/agent/ws          ┌───────────────┐
        │  dashboard   │  ◀── tRPC ──▶  ┌──────────┐  ◀──────│  agent (node) │
        │  apps/app    │                │ apps/api │         │  /var/run/    │
        └──────────────┘                │ gateway  │  ◀──────│  docker.sock  │
                                        └──────────┘         └───────────────┘
                                          ▲   ▲                 (one per node)
                                  Postgres│   │Better Auth
```

The controller never touches a node's Docker socket directly. Each node runs a
small **agent** that dials *out* to the controller over an authenticated
WebSocket, pushes stats + container/service state, and executes typed commands.

## Stack

| Layer | Pick |
|---|---|
| Runtime + package manager | Bun (`bun@1.3.10`) |
| Monorepo | Turborepo |
| Language | TypeScript (strict, bundler resolution) |
| UI | React 19, Vite, TanStack Router/Start, Tailwind CSS 4, Radix + shadcn, framer-motion |
| API | tRPC v11 over Hono (Bun) |
| DB | Prisma 7 + Postgres (`@prisma/adapter-pg`) |
| Auth | Better Auth (organization plugin) |
| Validation | Zod |

## Workspaces

```
apps/
  web      Marketing site         (TanStack Start, :4000)
  app      Dashboard SPA          (TanStack Router, :3003 → proxies /api, /agent → :3001)
  api      Controller host        (Hono + Bun, tRPC + Better Auth + agent WS gateway, :3001)
  agent    Node agent             (Bun + dockerode; runs on every node)
  e2e      Playwright smoke tests
packages/
  core     Shared types + Zod agent↔controller protocol + dockerode wrapper
  db       Prisma schema + client
  auth     Better Auth server/client
  ingress  Pluggable ingress drivers (caddy | traefik | none)
  trpc     All routers, services, and the agent-command hub interface
  ui       Tailwind 4 + shadcn component library
```

## Quick start

```bash
bun install
cp .env.example .env   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
bun docker:up          # Postgres on :5678 (reads .env)
bun db:generate        # generate Prisma client
bun db:push            # create the schema
bun dev                # api (:3001) + app (:3003)
```

> **Port 5678 already taken?** Set `SWARMY_DB_PORT` in `.env` to a free port
> (e.g. `5679`) and change the port in `DATABASE_URL` to match. `bun docker:up`
> and the Prisma helpers both read `.env`, so everything follows automatically.

Open http://localhost:3003, create an account, then **Settings → Tokens** to mint
a join token. On each node:

```bash
SWARMY_JOIN_TOKEN=swt_… AGENT_WS_URL=ws://controller:3001/agent/ws bun apps/agent/src/index.ts
# or run the prebuilt agent container (see apps/agent/Dockerfile)
```

## Scripts

| Command | Does |
|---|---|
| `bun dev` | Run controller + dashboard (Turbo) |
| `bun dev:web` | Run the marketing site |
| `bun build` | Build every workspace |
| `bun typecheck` | Type-check the graph |
| `bun db:push` / `bun db:migrate` / `bun db:studio` | Prisma helpers |
| `bun docker:up` / `bun docker:down` | Local Postgres (+ `--profile ingress`) |

## Ingress is optional

Per organization you choose a driver: `caddy`, `traefik`, or `none`. With `none`
(the default) swarmy records your domains for display but writes **no** routing
config — you own routing entirely. Adding a new driver is a single file
implementing the `IngressDriver` interface registered in `@swarmy/ingress`.

## Roadmap

The product roadmap and per-epic design docs live in [`plans/`](./plans) —
start with [`plans/ROADMAP.md`](./plans/ROADMAP.md) and
[`plans/RECOMMENDATIONS.md`](./plans/RECOMMENDATIONS.md).

## License

[Functional Source License (FSL-1.1-ALv2)](./LICENSE.md) — use it for almost
anything, including commercially; you just can't resell swarmy as a competing
managed service. Each release converts to Apache-2.0 after two years.

