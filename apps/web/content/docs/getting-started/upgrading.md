---
title: "Upgrading"
description: "Upgrade a self-hosted controller and its agents by re-running the installer."
---

The installer is also the upgrader: re-run it on the controller host. Each
phase is marker-gated in `/var/lib/swarmy/install/state.env`, so a re-run
converges instead of duplicating anything.

## Images

The installer deploys `ghcr.io/requestflo/swarmy-controller:latest` and (for
node #1) `ghcr.io/requestflo/swarmy-agent:latest`. `:latest` follows the `main`
branch. Each release tag also publishes `:<version>` and `:<major>.<minor>`
(for example `:1.0.0` and `:1.0`). To pin a version, pass it explicitly:

```bash
--image ghcr.io/requestflo/swarmy-controller:1.0.0 \
--agent-image ghcr.io/requestflo/swarmy-agent:1.0.0
```

## Before you upgrade: back up `state.env`

`/var/lib/swarmy/install/state.env` (mode 600) holds `SWARMY_SECRET_KEY`, which
encrypts every credential swarmy stores. It also holds `BETTER_AUTH_SECRET`, the
swarm join tokens and the admin password. The installer
generates these once and reuses them on every run. If you lose the file,
**stored credentials are unrecoverable**. Copy it somewhere off the server:

```bash
sudo cp /var/lib/swarmy/install/state.env ~/swarmy-state.env.$(date +%F)
# then move it to your password manager / offline storage
```

A controller backup bundle from the **Backup destinations** page also carries
these keys and the database, so it's a good second copy.

## Upgrade

Re-run the installer **with the same flags you installed with**. The installer
does not remember most flags: `--admin-email`, `--port`,
`--allow-signup`, `--image` / `--agent-image`, and a `SWARMY_PUBLIC_URL`
override all fall back to their defaults if you leave them out. In particular:

- There is one controller tier: an embedded SQLite store, no database service.
  `--standard` was removed and now errors. A controller installed with the old
  Postgres tier can't be upgraded in place; the installer refuses and asks for a
  fresh install.
  A lite controller from before the SQLite switch (embedded PGlite) is not
  migrated either: it comes up on a new, empty `control.db`. Pre-launch, there
  is no conversion path.
- Leaving out `--allow-signup` sets the controller back to invite-only.
- In interactive mode, the admin-email prompt defaults to `admin@localhost`. If
  you enter a different address than the one you installed with, a **second**
  owner account is created.

Use `--non-interactive` so nothing is prompted:

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh \
  | sudo bash -s -- --non-interactive --admin-email you@example.com   # + your other flags, as installed
```

To upgrade from a release tag instead of `main`, also set `SWARMY_REF`. The
installer fetches its stack file from the same ref:

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/v1.0.0/scripts/install-swarmy.sh \
  | sudo SWARMY_REF=v1.0.0 bash -s -- --non-interactive --admin-email you@example.com \
      --image ghcr.io/requestflo/swarmy-controller:1.0.0 --agent-image ghcr.io/requestflo/swarmy-agent:1.0.0
```

What the re-run does:

- It skips the phases it already completed (egress check, Docker install, swarm
  init) and reuses the secrets in `state.env`. Existing Docker secrets are kept
  as they are.
- It runs `docker stack deploy` again. That re-resolves the image tag against
  the registry, so the controller rolls to the new image. On start, the
  controller applies any pending database migrations itself (to `control.db`
  and `telemetry.db`). The bootstrap seed is idempotent, so no new org, owner or token
  appears.
- It **leaves a running node #1 agent alone** and doesn't update the agents on
  your other nodes. See the next section.

## Upgrade the agents

When a node's agent version differs from the one the controller ships, the
node's page shows an **Update to `<version>`** button (admins only). Here's
what it does:

- **systemd nodes**: downloads the new binary from the controller, checks it
  against a pinned sha256, swaps it in (keeping `<bin>.old` for rollback), and
  restarts. On the box, `swarmy-agent update` does the same thing.
- **Container nodes, including node #1**: pulls the matching
  `swarmy-agent:<version>` image and recreates the agent container with the
  same env and volumes.

## What persists

| Where | What |
|---|---|
| `/var/lib/swarmy/install/state.env` | Installer secrets + phase markers (controller host) |
| Docker secrets (`swarmy_secret_key`, `better_auth_secret`, `admin_password`, …) | The same secrets, as mounted by the controller |
| `swarmy_swarmy-data` volume | The controller's database: `data/control.db` and `data/telemetry.db` (mounted at `/var/lib/swarmy`) |
| `swarmy-agent` volume (node #1) / `/var/lib/swarmy/agent.json` (systemd nodes) | Each agent's stored session |
| Your stacks' volumes, the Caddy data volumes | App data and issued certificates; not touched by an upgrade |

Agents reconnect on their **stored session**, not on a join token. That means a
restart, an upgrade, or the installer's bootstrap token expiring (it lasts
24 hours / 5 uses) doesn't disconnect any node. If a node doesn't come back
after an upgrade, use **Repair this node**. See
[Node recovery](/docs/guides/node-recovery).

`--uninstall` removes the stack, the Docker secrets and the node #1 agent, but
keeps the data volumes and `state.env`. A later install picks them back up.
