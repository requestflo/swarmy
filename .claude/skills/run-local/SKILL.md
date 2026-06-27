---
name: run-local
description: Run swarmy locally — backing services (Postgres via docker compose) and the dev servers (controller API :3001 + dashboard :3003, or the marketing web app). Use when asked to start, run, boot, or see the app locally, verify a change in the browser, or stand up the local database. Covers env setup, the SWARMY_DB_PORT port-conflict knob, and troubleshooting.
---

# Run swarmy locally

The local stack is two layers: **backing services** (Postgres in Docker) and the
**dev servers** (Bun/Vite via Turbo). Both read the repo-root `.env`.

| Layer | Command | Ports |
|---|---|---|
| Postgres (Docker) | `bun docker:up` / `bun docker:down` | host `5678` → container `5432` |
| Controller API + dashboard | `bun dev:app` | API `:3001`, app `:3003` |
| Everything (api + app, Turbo) | `bun dev` | `:3001`, `:3003` |
| Marketing site | `bun dev:web` | Vite default |

`bun dev` has a `predev` hook that kills ports 3001/3003/4000 first; `bun dev:app`
does not, so make sure those ports are free.

## One-time setup

```bash
bun install
cp .env.example .env          # then set BETTER_AUTH_SECRET: openssl rand -base64 32
bun docker:up                 # start Postgres (reads .env)
bun db:generate               # generate the Prisma client
bun db:push                   # create the schema in the running DB
```

`BETTER_AUTH_SECRET` ships as the placeholder `replace-me-…` — Better Auth needs a
real secret or login/signup misbehaves. Generate one with `openssl rand -base64 32`.

## Day-to-day: start it

```bash
bun docker:up                 # if Postgres isn't already running
bun dev:app                   # API :3001 + dashboard :3003
```

Then open **http://localhost:3003**. With no session it redirects to `/login`;
create an account (or "Sign up" for the first one), then **Settings → Tokens** to
mint a node join token. Verify the API directly with
`curl http://localhost:3001/health` → `{"ok":true,...}`.

When driving the browser to verify a change, **screenshot and actually look** —
`/login` rendering the Hot Signal styling (navy gradient, coral accents) means the
app booted; a blank frame means it didn't.

## Port 5678 already taken

Common when another project runs its own Postgres on 5678. Don't fight it — move
swarmy's host port:

1. In `.env`, set `SWARMY_DB_PORT` to a free port (e.g. `5679`).
2. Change the port in `DATABASE_URL` to **match** (`…@localhost:5679/…`).
3. `bun docker:up` (compose reads `SWARMY_DB_PORT`) and `bun db:push` (reads
   `DATABASE_URL`) both follow automatically.

The container port stays 5432; only the host mapping changes.

## How env reaches each tool (why the scripts look the way they do)

Bun and Docker Compose each auto-load `.env` only from their own working
directory, **not** the repo root when invoked through `bun --filter` /
`-f docker/…`. So the root scripts pass it explicitly:

- `docker:up` / `docker:down` → `docker compose --env-file .env …`
- `db:push` / `db:migrate` / `db:studio` → `bun --env-file=.env --filter …`

If you run a Prisma command by hand inside `packages/db`, pass the URL yourself:
`DATABASE_URL=… bunx prisma db push`. Otherwise the CLI falls back to the
hard-coded `localhost:5678` in `packages/db/prisma.config.ts` and silently hits the
wrong database.

## Ingress drivers (optional)

To exercise the caddy/traefik ingress drivers locally:

```bash
bun docker:up --profile ingress      # also starts caddy + traefik
```

(Bound to non-conflicting host ports — see `docker/docker-compose.yml`.)

## Stop / reset

```bash
bun docker:down                       # stop Postgres (keeps data volume)
docker compose --env-file .env -f docker/docker-compose.yml down -v   # also wipe data
```

After wiping the volume, re-run `bun db:push` to recreate the schema.

## VS Code

`.vscode/tasks.json` (local, gitignored) auto-runs **swarmy: backing services** on
folder open and offers **swarmy: dev (api + app)** as a one-click task. The first
time, VS Code prompts to allow automatic tasks (or run *Tasks: Manage Automatic
Tasks → Allow*).

## Troubleshooting

- **`P1000 Authentication failed … at localhost:5678`** — a Prisma command didn't
  get `DATABASE_URL`; it fell back to 5678 and hit the wrong/locked DB. Run via the
  root `bun db:*` scripts, or prefix `DATABASE_URL=…`.
- **`DATABASE_URL is not set`** at API startup — the controller's `.env` isn't being
  loaded; launch from repo root (`bun dev:app`).
- **`Bind for 0.0.0.0:5678 failed: port is already allocated`** — see *Port 5678
  already taken* above.
- **Login/signup acts weird** — check `BETTER_AUTH_SECRET` is a real value, not the
  placeholder.
