# Node recovery & the `swarmy-agent` CLI

Every swarmy node ships a single self-contained binary, `swarmy-agent`, that is
both the daemon (what systemd runs) and a diagnostics/recovery CLI. When a node
won't come back ONLINE, this is the runbook.

## TL;DR

1. **From the dashboard** — on an offline node's page, click **Repair this
   node**, copy the one-liner, paste it on the box. Safe to run on an
   already-enrolled machine: it repairs in place, keeps the node's identity.
2. **On the box** — `swarmy-agent doctor` tells you what's wrong;
   `swarmy-agent doctor --fix` applies the safe fixes.
3. **Data at risk on a node that won't reconnect** — `swarmy-agent backup
   export --stack <name> --to /mnt/usb/backup.tar.gz` works with the controller
   completely dark.

## The self-healing one-liner

Re-running the dashboard's **Add a node** command on a box that already has
swarmy is the supported repair path. The installer detects the existing install
and switches to **repair mode**:

- refreshes the agent binary to the controller's current version,
- refreshes credentials (a fresh join token + mesh setup key from the
  one-liner; anything you don't pass is salvaged from the existing
  `/etc/swarmy/agent.env`),
- restarts the service,
- runs `swarmy-agent doctor --repair` (applies safe fixes, prints the result).

The node keeps its identity throughout: the controller **re-adopts** it by
hostname, and a consumed single-use token stays valid *for the one node it
enrolled*, so a plain reboot or a repair never creates a duplicate node.

## `swarmy-agent` commands

Run on the node itself (SSH in). No args on a terminal opens the **TUI**; no
args under systemd runs the daemon.

| Command | What it does |
|---|---|
| `status [--json]` | one-glance summary: daemon, session, mesh, swarm |
| `doctor [--fix] [--json]` | full health ladder; `--fix` applies safe repairs |
| `reconnect` | force an immediate controller redial |
| `rejoin [--force]` | swarm-membership repair (see below) |
| `mesh status \| ping <ip> \| join \| leave` | local mesh ops |
| `backup export \| restore \| push \| list` | rescue backups (see below) |
| `logs [-f] [--container X]` | agent journal / container logs |
| `support-bundle [--out p]` | redacted diagnostics tarball to share |
| `update` | self-update from the controller's manifest |
| `reset [--keep-data]` | factory-reset this node (typed confirmation) |

Fixes are tiered: **green** apply automatically, **yellow** prompt (or `--yes`),
**red** (leave/force/reset/restore-overwrite) require typing a confirmation
phrase and are never `--yes`-able.

## Recovery ladder, by symptom

**Node OFFLINE, machine is up.** Re-run the repair one-liner, or on the box:
`swarmy-agent doctor` → follow the hints → `swarmy-agent reconnect`.

**`4401 invalid join token` / `session rejected` in the logs.** Credentials are
stale. Re-run the repair one-liner (mints fresh ones). The session file is now
written durably (with retry + read-back verification), so this shouldn't recur
after one repair.

**Swarm traffic not on the mesh** (doctor warns "advertising `<LAN IP>` but mesh
IP is `<mesh IP>`"). `swarmy-agent rejoin --force` re-forms this node's
membership on the mesh IP. On a worker it leaves and the controller re-joins it;
on a sole manager it uses `docker swarm init --force-new-cluster` (services and
data are kept).

**Every credential is gone** (session file deleted AND the env-file token
revoked). The daemon enters **recovery mode** after repeated auth failures: it
prints a **fingerprint** in its journal and posts a claim to the controller. In
the dashboard (Infrastructure), a banner appears — **approve it only if the
fingerprint matches** what the machine printed (`journalctl -u swarmy-agent`).
On approval the node receives a fresh session credential and reconnects as its
old self. This is the SSH-host-key trust model: the claim is unauthenticated, so
the human fingerprint comparison is the security boundary. Claims only ever
attach to an existing node (recovery can't enroll a new one), expire in 15
minutes, and deliver their credential exactly once.

## Rescue backups (controller-down safe)

The normal backup path is controller-driven; these run locally when a node is
cut off. Data always moves through short-lived sidecar containers with the
volumes bind-mounted, so any volume driver works.

```sh
# Tar a stack's named volumes + a manifest — no credentials needed.
swarmy-agent backup export --stack myapp --to /mnt/usb/myapp.tar.gz
# (--stop to quiesce containers first for a consistent copy)

# Recreate the volumes anywhere from that tarball.
swarmy-agent backup restore --from /mnt/usb/myapp.tar.gz     # --force to overwrite

# Straight to a restic repo with YOUR credentials (env or prompt, never argv).
RESTIC_PASSWORD=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
  swarmy-agent backup push --stack myapp --repo s3:s3.amazonaws.com/bucket/prefix

# Inspect local exports or repo snapshots.
swarmy-agent backup list --from /mnt/usb
swarmy-agent backup list --repo s3:… 
```

## Crash forensics

When the agent service fails, systemd's `OnFailure=` fires a one-shot that
writes a full doctor report to `/var/lib/swarmy/last-failure.json` — so "why did
it crash overnight?" has an answer even after journald rotates.
