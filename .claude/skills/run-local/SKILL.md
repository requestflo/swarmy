---
name: run-local
description: Run swarmy locally — the dev servers (controller API :3021 + dashboard :3023, or the marketing web app) over the controller's embedded SQLite store (no database server, no docker compose needed). Use when asked to start, run, boot, or see the app locally, verify a change in the browser, or reset the local database. Covers env setup, where the SQLite files live, migrations (db:migration / db:check), and troubleshooting.
---

# Run swarmy locally

The controller needs **no backing services**. Its store is embedded SQLite
(`bun:sqlite`, in-process): two files, `control.db` (every model) and
`telemetry.db` (`MetricSample` only), in `SWARMY_DATA_DIR`. Unset, that is
`<repo>/.swarmy/data` (gitignored). The controller creates the files and applies
migrations on boot (`ensureSchema`). The dev servers (Bun/Vite via Turbo) read the
repo-root `.env`.

| Layer | Command | Ports |
|---|---|---|
| Controller API + dashboard | `bun dev:app` | API `:3021`, app `:3023` |
| Everything (api + app, Turbo) | `bun dev` | `:3021`, `:3023` |
| Marketing site | `bun dev:web` | Vite default |

`bun dev` has a `predev` hook that kills ports 3021/3023/4020 first; `bun dev:app`
does not, so make sure those ports are free.

## One-time setup

```bash
bun install
cp .env.example .env          # then set BETTER_AUTH_SECRET: openssl rand -base64 32
bun db:generate               # generate both Prisma clients (control + telemetry)
```

No schema step: the controller (and `seed-dev`) migrates `.swarmy/data/*.db` on
boot.

`BETTER_AUTH_SECRET` ships as the placeholder `replace-me-…` — Better Auth needs a
real secret or login/signup misbehaves. Generate one with `openssl rand -base64 32`.

## Day-to-day: start it

```bash
bun dev:app                   # API :3021 + dashboard :3023
```

Then open **http://localhost:3023**. With no session it redirects to `/login`;
create an account (or "Sign up" for the first one), then **Settings → Tokens** to
mint a node join token. Verify the API directly with
`curl http://localhost:3021/health` → `{"ok":true,...}`.

When driving the browser to verify a change, **screenshot and actually look** —
`/login` rendering the Hot Signal styling (navy gradient, coral accents) means the
app booted; a blank frame means it didn't.

## Full local swarm (controller + a real node)

To run the **genuine product loop** — a controller with a real agent attached to
the laptop's Docker, so a node shows up ONLINE — use the one-command path:

```bash
bun run dev:up        # Docker check + swarm init + db:generate + seed
```

`dev:up` is idempotent: it `docker swarm init`s the host (single-node manager, so
the agent can `docker service`), generates the Prisma clients, then `seed-dev`s
(which applies migrations to `.swarmy/data`) a dev user + org + one join token. The raw token lands in
`.swarmy-dev-token` (gitignored). Then, in two terminals:

```bash
bun dev               # controller API :3021 + dashboard :3023
bun run dev:agent     # local agent → ws://localhost:3021/agent/ws, /var/run/docker.sock
```

Log in at <http://localhost:3023> with **dev@swarmy.local / swarmy-dev** and the
node appears on the Infrastructure plane. The active org is auto-selected on
sign-in (a Better Auth session hook in `@swarmy/auth` picks the user's org).

Scripts: `scripts/dev-up.sh`, `scripts/seed-dev.ts`, `scripts/run-agent.sh`.
Wired as root scripts `dev:up`, `seed-dev`, `dev:agent`. Full walkthrough +
troubleshooting (swarm init, socket perms, remote-node onboarding, demo mode):
**`docs/LOCAL-SWARM.md`**.

**Multi-node (real VMs)** — for a genuine multi-node swarm with the production
install path (Bun-compiled agent binary under systemd, downloaded from the
controller), use `bun run dev:vms up`. It launches [Lima](https://lima-vm.io)
VMs (native arm64, QEMU + `hvf` on Apple Silicon) and enrolls each via
`curl | sh`. See `scripts/local-vms.sh` and `docs/LOCAL-SWARM.md` §4.

**Demo mode** — visit the dashboard with `?demo=1` for a zero-backend, in-memory
interactive demo (no Docker/DB/agent needed). The flag is sticky in
`localStorage` until the "Get swarmy" CTA clears it.

## Where the data lives, and overrides

| File | Holds | Override |
|---|---|---|
| `$SWARMY_DATA_DIR/control.db` | every control-plane model | `SWARMY_DB_PATH` |
| `$SWARMY_DATA_DIR/telemetry.db` | `MetricSample` only | `SWARMY_TELEMETRY_DB_PATH` |

`SWARMY_DATA_DIR` defaults to `<repo>/.swarmy/data` in dev and is
`/var/lib/swarmy/data` in prod. The files run in WAL mode, so you also see
`-wal`/`-shm` files beside them. A second process (a script, `bun run reset-2fa`,
`sqlite3`) can open `control.db` while the controller runs.

`bun db:studio` opens `control.db` through `packages/db/prisma.config.ts`
(`SWARMY_DB_URL` overrides its `file:` URL).

## Schema changes

- Edit `packages/db/prisma/schema/*.prisma`, then `bun run db:migration <name>`
  (root) or `bun run --cwd packages/db db:migration <name>`. Add `--telemetry` for
  `telemetry.db`. It writes the next migration folder from the schema diff.
- `bun run db:check` is the CI gate: it applies every migration through
  `ensureSchema` to a scratch file and fails on drift.
- Restart the controller (or re-run `seed-dev`) to apply it locally.
- There is no `db:push` / `db:migrate`. `prisma db push` can't be used: Prisma
  renders `Json @default("{}")` unquoted in SQLite DDL; `scripts/migration.ts`
  fixes that in the generated SQL.

## How env reaches each tool

Bun auto-loads `.env` only from its own working directory, so launch the dev
servers from the repo root (`bun dev`, `bun dev:app`). `docker:up` / `docker:down`
pass `--env-file .env` explicitly. With `SWARMY_DATA_DIR` unset, the controller,
`seed-dev` and `db:studio` all resolve the same `<repo>/.swarmy/data`.

## Ingress drivers (optional)

`docker/docker-compose.yml` now holds only the optional `ingress` profile. To
exercise the caddy ingress driver locally:

```bash
docker compose --env-file .env -f docker/docker-compose.yml --profile ingress up -d   # caddy
```

(Bound to non-conflicting host ports — see `docker/docker-compose.yml`.)

## Stop / reset

Stop the dev servers with Ctrl-C. To wipe the local database, stop the
controller and delete the data dir:

```bash
rm -rf .swarmy/data          # control.db, telemetry.db and their -wal/-shm
bun run seed-dev             # optional: recreate + migrate + seed the dev login
```

The next controller boot recreates and migrates empty files.

## VS Code

`.vscode/tasks.json` (local, gitignored) may still auto-run a **swarmy: backing services** task on folder open; it is no
longer needed (nothing to start). It offers **swarmy: dev (api + app)** as a one-click task. The first
time, VS Code prompts to allow automatic tasks (or run *Tasks: Manage Automatic
Tasks → Allow*).

## Troubleshooting

- **`SQLITE_BUSY` / "database is locked"** — another process held the write lock
  past `busy_timeout` (5 s). Usually a stuck script or an open `sqlite3` shell with
  a write transaction; close it.
- **Schema errors after pulling** (missing column/table) — restart the controller;
  it applies new migrations on boot. If a migration was edited in place
  (pre-launch squash), `rm -rf .swarmy/data` and re-seed.
- **`db:check` fails** — the schema and the migrations disagree; run
  `bun run db:migration <name>` and commit the new folder.
- **Login/signup acts weird** — check `BETTER_AUTH_SECRET` is a real value, not the
  placeholder.
