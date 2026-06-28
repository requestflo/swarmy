# Run a full local swarm (controller + a real node)

This walks you from a clean checkout to a **running swarmy controller with a real
node attached to your laptop's Docker** — you log in and watch the node go
ONLINE on the Infrastructure plane. It's the genuine product loop (controller ↔
agent over the WebSocket gateway), just pointed at localhost.

Everything below assumes the repo root as the working directory.

---

## Prerequisites

- **Docker** — Docker Desktop (macOS/Windows) or Docker Engine (Linux), running,
  with **Swarm mode** available (it's built in; `bun run dev:up` enables it).
- **Bun** ≥ 1.3 — <https://bun.sh>
- A free TCP port **5678** for Postgres (override with `SWARMY_DB_PORT` if taken).

```bash
bun install
```

`bun run dev:up` copies `.env.example` → `.env` for you on first run. Before you
log in, set a **real** `BETTER_AUTH_SECRET` in `.env` (Better Auth misbehaves on
the placeholder):

```bash
openssl rand -base64 32   # paste into BETTER_AUTH_SECRET in .env
```

---

## 1. One command: bring up the backend

```bash
bun run dev:up
```

This is idempotent and does, in order:

1. Verifies Docker is running.
2. `docker swarm init` if the host isn't already a swarm — makes **this laptop a
   single-node manager** so the agent can drive `docker service`. Re-runs are a
   no-op.
3. `bun docker:up` — starts Postgres, then waits for it to report healthy.
4. `bun db:generate` + `bun db:push` — Prisma client and schema.
5. `bun run seed-dev` — creates (or reuses) a dev login user, an org, an owner
   membership, and **one join token**. The raw token is written to
   `.swarmy-dev-token` (gitignored) and printed.

It finishes by printing the two commands to run next.

---

## 2. Two terminals: controller + node

```bash
# Terminal 1 — controller API (:3001) + dashboard (:3003)
bun dev

# Terminal 2 — a local agent against THIS laptop's Docker socket
bun run dev:agent
```

`bun run dev:agent` reads the token from `$SWARMY_JOIN_TOKEN` or
`.swarmy-dev-token`, points the agent at `ws://localhost:3001/agent/ws`, mounts
`/var/run/docker.sock`, and starts the agent. On a successful register you'll see
`registered as node <id>` in its log.

---

## 3. Log in and SEE the node

Open **<http://localhost:3003>** and sign in:

| field    | value             |
| -------- | ----------------- |
| email    | `dev@swarmy.local` |
| password | `swarmy-dev`      |

You land directly in your org (the active org is selected on sign-in). Go to the
**Infrastructure** plane — your laptop appears as a node, flipping to **ONLINE**
once the agent's heartbeat lands. Live CPU/memory/containers stream in from the
real Docker daemon.

> The seeded credentials and token are for **local development only**. Never use
> them on a controller anyone else can reach.

---

## The genuine onboarding flow (for a remote box)

The seed token is a shortcut for the local node. The real product flow — the one
a teammate uses to add a server — is in the dashboard:

1. **Deploy → Add a node** (or the Infrastructure plane's "Add node").
2. Pick the OS, optionally set a role/labels, and **mint a join token**.
3. Copy the one-liner and run it on a **fresh Linux box**:

   ```bash
   curl -fsSL http://localhost:3001/install.sh | SWARMY_JOIN_TOKEN=<token> sh
   ```

   It installs Docker if needed, starts the agent, and the node phones home —
   the "Add a node" panel flips to a success link when it connects.

`seed-dev` prints this same one-liner with the dev token so you can try it
against a VM. For a box that isn't your laptop, replace `localhost:3001` with a
URL the box can actually reach (`CONTROLLER_PUBLIC_URL`).

---

## Demo mode (zero backend)

Want to click around with **no Docker, no DB, no agent**? Visit the dashboard
with `?demo=1`:

```
http://localhost:3003/?demo=1
```

This runs a fully interactive demo against an in-memory store (auth is bypassed,
data is seeded client-side). The flag is sticky in `localStorage` until you exit
via the "Get swarmy" CTA. Useful for UI work and tyre-kicking without standing
up any of the above. (Owned by `apps/app/src/demo`.)

---

## Troubleshooting

- **`Docker is not running`** — start Docker Desktop / the engine. `dev:up`
  checks `docker info` up front.
- **`docker swarm init failed`** — usually multiple network interfaces. `dev:up`
  retries with `--advertise-addr 127.0.0.1`; if it still fails, run
  `docker swarm init --advertise-addr <your-ip>` once by hand, then re-run.
- **Node never goes ONLINE / `invalid join token`** — the controller hashes the
  raw token and looks up the `JoinToken` row; a mismatch means the token in
  `.swarmy-dev-token` doesn't match the DB. Re-seed: delete `.swarmy-dev-token`,
  revoke the old token in **Settings → Tokens**, then `bun run seed-dev`.
- **`Bind for 0.0.0.0:5678 failed: port is already allocated`** — another
  Postgres owns 5678. Set `SWARMY_DB_PORT` to a free port in `.env` **and** match
  the port in `DATABASE_URL`, then re-run `bun run dev:up`.
- **Socket permission denied (Linux)** — your user isn't in the `docker` group.
  Either `sudo usermod -aG docker $USER` (then re-login) or run the agent with a
  socket your user can read; override with `DOCKER_SOCKET=…` if it lives
  elsewhere.
- **Login/signup acts weird** — `BETTER_AUTH_SECRET` is still the placeholder.
  Set a real one (`openssl rand -base64 32`) and restart `bun dev`.
- **No active organization (403 on the dashboard)** — happens if you signed in as
  a user with no membership. The seeded `dev@swarmy.local` always has one; for
  other users, create or join an org from the login screen's sign-up flow.

---

## Reset

```bash
bun docker:down                                                   # stop Postgres (keep data)
docker compose --env-file .env -f docker/docker-compose.yml down -v   # also wipe data
rm -f .swarmy-dev-token                                           # forget the dev token
docker swarm leave --force                                        # leave swarm mode (optional)
```

After a data wipe, re-run `bun run dev:up` to recreate the schema and seed.
