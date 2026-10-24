---
title: "Upgrading"
description: "Upgrade a self-hosted controller and its agents by re-running the installer."
---

The installer is also the upgrader: re-run it on the controller host. Each
phase is marker-gated in `/var/lib/swarmy/install/state.env`, so a re-run
converges instead of duplicating anything.

## Images

Each release publishes an installer that is **pinned to that release**:

- `https://github.com/requestflo/swarmy/releases/download/stable/install-swarmy.sh`
  is the latest stable release;
- `…/download/v<version>/install-swarmy.sh` is one exact release;
- `…/download/edge/install-swarmy.sh` is the latest `main` build.

A pinned installer deploys `swarmy-controller:<version>@sha256:…` and (for
node #1) `swarmy-agent:<version>@sha256:…`. Those are the digests CI built and
listed in the release's signed `platform.json`. The installer also carries the
release's own stack file, so it downloads nothing that can move.

The script on `main`
(`raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh`)
is not a release build. It deploys `:latest`, fetches `main`'s stack file, and
says so with a warning.

`--image` / `--agent-image` override the pins, with a warning. An image you
pass explicitly is remembered for later re-runs. Re-running without one goes
back to the installer's pin:

```bash
--image ghcr.io/requestflo/swarmy-controller:1.0.0 \
--agent-image ghcr.io/requestflo/swarmy-agent:1.0.0
```

An older installer never rolls the platform back. If **Settings → Platform**
already upgraded the controller past the installer's release, a re-run keeps
the running controller and agent and prints a warning. Use that release's
installer, or pass `--image` to force one.

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
`--allow-signup` and a `SWARMY_PUBLIC_URL` override all fall back to their
defaults if you leave them out (`--image` / `--agent-image` are remembered, see
[Images](#images)). In particular:

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

To upgrade to a release instead of `main`, pipe that release's installer
(`https://github.com/requestflo/swarmy/releases/download/v1.0.0/install-swarmy.sh`,
or `…/download/stable/…`) the same way. It brings its own images and stack
file. `SWARMY_REF` / `SWARMY_RAW_BASE` still point the stack file somewhere
else, with a warning.

What the re-run does:

- It skips the phases it already completed (egress check, Docker install, swarm
  init) and reuses the secrets in `state.env`. Existing Docker secrets are kept
  as they are.
- It runs `docker stack deploy` again with the installer's pinned controller
  image (or the one you passed), so the controller rolls to it. A controller
  that is already newer is kept (see [Images](#images)). On start, the
  controller applies any pending database migrations itself (to `control.db`
  and `telemetry.db`). The bootstrap seed is idempotent, so no new org, owner or token
  appears.
- It replaces node #1's agent container when the pinned agent image differs
  from the running one (its identity is on the `swarmy-agent` volume, so it
  reconnects on its stored session). It doesn't update the agents on your
  other nodes. See the next section.

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

## Uninstall

`--uninstall` takes swarmy off the controller host. It always removes:

- the stack and swarmy's Docker secrets;
- node #1's agent: its container, the `swarmy-agent` volume with its stored
  session (`agent.json`), and `/etc/swarmy/agent.env`;
- the saved `add-node.txt` one-liner and the generated `admin-password` file.

It also rotates both swarm join tokens. The old tokens were in `state.env`, the
Docker secrets, controller backups and install logs, and only the controller
used them. Nodes that have already joined keep working.

By default it also **deletes the data**: the `swarmy_swarmy-data` volume (the
controller's database), `state.env` (its `SWARMY_SECRET_KEY` is the only key to
that database), and the mesh. That means the mesh control plane and its store,
the `swarmy-netbird` client sidecar and its WireGuard identity, and the mesh pin.
It asks you to type `delete swarmy data` first. With `--non-interactive`, pass
`--yes` instead. Without one of them, nothing is removed.

To reinstall later on the same host, use `--uninstall --keep-data`. It keeps the
database, `state.env` and the mesh: the swarm was formed on the mesh address,
so the mesh stays up. A later install picks them back up.

The swarm itself and your apps' volumes are never touched. On the last node,
`docker swarm leave --force` removes the swarm too.

On other nodes, the node installer's `--uninstall` (`curl -fsSL
https://<dashboard>/install/loader.sh | sudo sh -s -- --uninstall`) removes:

- the agent and its binary;
- `/etc/swarmy/agent.env`;
- the stored session (`/var/lib/swarmy/agent.json` or the `swarmy-agent` volume);
- the mesh client sidecar and its identity;
- the mesh pin.

It leaves swarm membership alone. Run `docker swarm leave` and remove the node
in the dashboard to take it out of the swarm. If the node runs the mesh control
plane, the uninstall stops until you pass `--keep-data` (keeps the control plane
and its store) or `--yes` (deletes them).

The node installer doesn't rotate the swarm join tokens:

- A node never stores one. The controller passes it to the join and Docker
  doesn't keep it.
- A worker can't rotate them, because only a manager can.
- Rotating them from one manager would revoke the tokens the controller uses
  to join every other node.

If you think a token leaked, rotate the swarm join tokens from the dashboard and
revoke the node's swarmy join token there.
