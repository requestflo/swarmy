---
title: "Quickstart: your first 10 minutes"
description: "From an empty server to a WordPress site on HTTPS, with a second node, a teammate and backups."
---

This walks a fresh install from an empty server to a WordPress site on HTTPS,
with a second node, a teammate, and backups. Every step is in the dashboard
unless it says otherwise.

You need:

- A fresh **Ubuntu or Debian** server with root access and internet egress
  (swarmy pulls its images from `ghcr.io` and Docker Hub).
- For public HTTPS: ports **80** and **443** open to the internet on that server,
  and a DNS name you can point at it (or use a free `sslip.io` name, below).
- Optionally, a second Linux box for step 3.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh | sudo bash
```

It asks a few questions (admin email, password, and optional
ingress/mesh choices for the dashboard itself). Press Enter to take the defaults;
a blank password gets generated. To skip the questions:

```bash
curl -fsSL https://raw.githubusercontent.com/requestflo/swarmy/main/scripts/install-swarmy.sh \
  | sudo bash -s -- --non-interactive --admin-email you@example.com
```

The installer installs Docker if it's missing, initialises a one-node swarm,
deploys the controller, and enrols this server as node #1. When it finishes it
prints:

- **Dashboard** — `http://<server-ip>:3021`
- **Login** — your admin email, and the password if it generated one (save it)
- **Add a node** — a one-liner for your next server (valid for 24 hours / 5 nodes)

Then **back up `/var/lib/swarmy/install/state.env`** somewhere off the server.
It holds `SWARMY_SECRET_KEY`, which encrypts every credential swarmy stores. If
you lose it, those credentials cannot be recovered.

## 2. Sign in

Open the dashboard URL and sign in with the admin login. Node #1 shows up
under **Nodes** and turns **online** within a few seconds.

Sign-up is **invite-only**: the login page has no "Sign up" link. Step 6
covers adding people.

## 3. Add a second node

**Nodes → Add a node**. Pick the node's role, mint a token, and copy the
one-liner. It looks like this:

```bash
curl -fsSL https://<dashboard>/install/loader.sh | SWARMY_JOIN_TOKEN=swt_… sh -s -- --controller https://<dashboard>
```

Nodes install over **HTTPS only**, and the installer checks the agent against
the signed swarmy release. A dashboard without an HTTPS address needs a
`--domain` first. See
[How node installs are protected](/docs/getting-started/install#how-node-installs-are-protected).

Run it **as root** on the new box. It installs Docker if needed, then installs
the agent (a systemd binary where systemd is available, otherwise a container).
The dashboard waits for the node and shows it online when it arrives; the
controller then joins it to the swarm.

The new box needs to reach the controller's port (3021), and the nodes need the
usual Docker Swarm ports open between them: 2377/tcp, 7946/tcp+udp and 4789/udp.

## 4. Deploy WordPress with a domain

**Blueprints → WordPress**. Give it a name and a **Domain**, choose a size, and
look over the plan. The plan lists the database, volumes, secrets and route
swarmy will create. Then deploy it.

Every new org has the **Caddy edge on by default**. By default Caddy runs on a
manager node (node #1) and publishes ports 80/443 there, so point your DNS name
at that node. No DNS name? Use `wp.<ip-with-dashes>.sslip.io`, for example
`wp.203-0-113-10.sslip.io`.

## 5. What HTTPS looks like

- **Public name or public IP**: Caddy gets a real Let's Encrypt certificate.
  The first request can take a few seconds while the certificate is issued.
  After that it's an ordinary padlock. This needs the DNS record to resolve to
  the edge node and ports 80/443 to be reachable from the internet.
- **Private name or IP**: this covers `.local`, `.lan`, `.internal`,
  `.home.arpa`, `.test`, `.localhost`, private IPs, and sslip.io/nip.io names
  that embed a private IP. Let's Encrypt can never validate these, so swarmy
  serves them with **Caddy's local CA** instead of retrying forever. Your
  browser shows a certificate warning the first time; accept it once, or trust
  Caddy's root CA on your machines. The domain field warns you when you type a
  name like this.

## 6. Invite a teammate

**Settings → Members → Invite member**. Enter their email and a role (member,
admin or owner). swarmy doesn't send email, so it gives you a **one-time
link**: copy it and send it yourself. They open it, create their account and
join your org. If they already have an account, the link switches them to
sign-in. Under **Settings → Members** you can also copy, regenerate or revoke
pending invites.

## 7. Backups

**Backup destinations** (in the sidebar under Platform) → **Add destination**.
Choose one of these:

- **S3**: any S3-compatible bucket (AWS, Backblaze B2, MinIO…). Enter the
  endpoint, bucket and keys.
- **Node path**: a directory on one of your nodes, e.g. `/srv/backups`.
- **Use swarmy object storage**: one click mints a bucket on the in-swarm
  replicated Garage store. Enable the replicated store on the same page first.

Backups are encrypted, deduplicated restic repositories.

Once a destination exists, **databases are backed up nightly with no further
clicks**. Managed Postgres gets a nightly `pg_dump`. Compose and blueprint
databases get a nightly volume backup: MariaDB/MySQL, Postgres, Mongo,
Redis/Valkey, as long as they sit on a named volume. That includes the
WordPress database you just deployed. Each keeps 7 backups, and runs are spread
between 02:00 and 05:00 UTC. A schedule you set yourself is never overridden.
Until a destination exists, the stack's **Backups** tab says backups are off,
and deploys aren't affected.

To **restore**, open the stack's **Backups** tab, pick a snapshot and click
**Restore**. Keep the volume name to restore in place (it overwrites that
volume), or give it a new volume name to restore next to the original. A
failed backup shows its failure reason on the snapshot row.

## 8. When something's wrong

- **A service is failing.** Its page shows **failing** and the **last task
  error**, so a crash-looping container tells you why without leaving the
  dashboard.
- **A node is offline.** Open it and use **Repair this node → Generate repair
  command**. This is the same one-liner as Add a node, with a fresh token. Run
  it on the box. It detects the existing install, refreshes the credentials,
  keeps the node's identity (no duplicate node) and runs the doctor's safe
  fixes.
- **On the box itself**, run `swarmy-agent doctor`, which walks the health
  checks and prints a hint for each failure. `swarmy-agent doctor --fix`
  applies the safe fixes. `swarmy-agent` with no arguments opens a live
  diagnostics TUI. On a container-backend node (node #1 included), run it
  through Docker:

  ```bash
  docker exec -it swarmy-agent bun run apps/agent/src/main.ts doctor
  ```

- **A disk is filling up.** swarmy caps container logs and cleans every node
  up automatically, and the default **Disk almost full** alert fires above 85%.
  - Every container swarmy deploys logs to `json-file`, capped at 10 MB × 3
    files. Override this per service with compose `logging:`.
  - Both installers also merge the same caps into `/etc/docker/daemon.json`
    as `"log-driver": "json-file"` with `"log-opts": {"max-size": "10m",
    "max-file": "3"}`, and cap journald at 500 MB.
  - The installers never change a `daemon.json` that already sets
    `log-driver` or `log-opts`. They keep a `.swarmy-bak` copy and only
    restart Docker when nothing is running.
  - Tune the caps with `SWARMY_LOG_MAX_SIZE`, `SWARMY_LOG_MAX_FILE` and
    `SWARMY_JOURNALD_MAX`.
  - Every 6 hours (sooner once the disk passes 85%), each node removes stopped
    one-off containers, images nothing has used for 7 days and build cache
    over 5 GB. It never removes an image a running service or the previous
    release uses. Each run shows as "Cleanup reclaimed … GB" on the node page,
    which also has a **Clean up now** button.
  - Tune the cleanup with node labels: `swarmy.hygiene.enabled=false`,
    `swarmy.hygiene.imageAgeDays` and `swarmy.hygiene.buildCacheGb`. Setting
    `SWARMY_ALLOW_HYGIENE=false` on the agent turns it off on that box.
- **The controller won't start.** Run `docker service logs swarmy_controller`.
  Re-running the installer with `--check` (`… | sudo bash -s -- --check`) runs
  only its preflight (network, egress) and changes nothing.

More in [Node recovery](/docs/guides/node-recovery). For upgrades, see
[Upgrading](/docs/getting-started/upgrading).
