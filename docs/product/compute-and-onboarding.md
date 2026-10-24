# Compute & onboarding — "paste one line, watch it come online"

**Status: canonical product design (2026-07). Pairs with the `agent-handlers`
skill for the how.**

## The feeling we are building

Someone with a swarmy account and a fresh Linux box should get from "empty VPS"
to "node ONLINE in the dashboard" with a single pasted line:

1. In the dashboard they open **Servers → Add a server**, say where it is (any
   Linux, Hetzner, DigitalOcean, a Raspberry Pi, a home lab behind NAT) and
   copy the one-liner:
   `curl -fsSL <controller>/install/loader.sh | SWARMY_JOIN_TOKEN=<token> sh -s -- --controller <controller>`.
   The clouds get the same line wrapped as cloud-config, so the server joins
   on its first boot.
2. On the box they paste it. The script installs Docker if missing, installs the
   agent as a managed service, initializes or joins the org's Docker Swarm
   **locally**, and starts dialing out.
3. While they wait, a radar of their servers listens for the new one to phone
   home. Within seconds a receipt says it is in: when it phoned home, its role,
   cores and memory and, with the private network on, whether it links direct
   or through a relay. It is on the **Servers** map from then on.
4. They flip its **ingress**/**outlet** switches, give it a **region**, set a
   monthly **cost**, and it starts carrying real traffic and showing up in
   per-stack cost breakdowns. To move a service's data onto it, they drag the
   service onto it on the map (or use **Move…**).

No SSH keys handed to a controller. No manager-vs-worker decision to agonize
over. No "install Docker, then build the agent, then set five env vars, then
`docker swarm init`." One line, and the machine joins the swarm. It should feel
like the box enrolled *itself* — because it did: **the agent dials out, the
controller never reaches in.**

## How it works (enrollment path)

```
fresh box                                       dashboard: "Add a server"
   │  ① curl <controller>/install/loader.sh | SWARMY_JOIN_TOKEN=… sh -s -- --controller …
   │     token (env, never the URL) resolves server-side to org, labels,
   │     role hint, profile; the loader pins version + checksums
   ▼
loader (tiny, reviewable) → installer (pinned, sha256) → agent binary (sha256)
   │  ② install Docker if missing · install agent as systemd service
   │     (Docker-container fallback) · swarm init/join LOCALLY on this box
   ▼
agent dials OUT: wss://…/agent/ws                (outbound only, NAT-friendly)
   │  ③ register { auth: { kind:'join', joinToken }, facts }
   │     controller upserts Node (orgId+hostname), mints per-node sessionSecret
   ▼
registerAck { nodeId, sessionCredential, heartbeat/metrics intervals }
   │  ④ agent persists session (0600) → reconnects as kind:'session' forever
   │     heartbeats + metrics + container/service/node snapshots stream up;
   │     commands stream down and run against the LOCAL Docker socket
   ▼
node ONLINE on the Servers map
```

Four ideas, one story:

- **The agent lives outside Docker.** It is a host-level reconciler — a
  Bun-compiled binary under systemd (`/usr/local/bin/swarmy-agent`), with the
  Docker-container install only as a fallback for hosts without systemd. The
  agent is the thing that manages, inspects, and repairs Docker; it must not
  depend on Docker being healthy to run. A wedged daemon, a full disk, a
  broken swarm — the agent survives all of them and is the hand that fixes
  them.
- **The agent dials out; the controller never reaches in.** The only runtime
  network dependency is the agent's outbound WSS. This is why swarmy works on a
  box behind NAT with zero inbound ports — and why swarm `init`/`join` happen on
  the box against its own Docker socket, never controller-initiated against a
  remote one.
- **The token rides an env var, never the URL.** The join token is passed as
  `SWARMY_JOIN_TOKEN` so it never lands in proxy/CDN logs; the controller
  resolves it to org, desired labels, role hint, and install profile. The loader
  body is identical for every request (its sha256 is pinned), it pins the
  installer, which pins the binaries. The token is the join token already in the
  DB, reused; no new secret type. Installers are POSIX `sh` — Alpine and busybox
  have no bash.
- **Docker Swarm is the substrate; swarmy is the UX over it.** Every node is a
  real swarm member; every service is a real swarm service. swarmy adds
  identity, roles, and a control loop — it does not replace Docker. A stack keeps
  running if swarmy disappears.

## Roles and where truth lives

- **Swarm membership, role (manager/worker), availability (drain), engine/OS,
  and labels are Docker truth**, read live from the swarm via the agent's node
  snapshots — never a DB column swarmy keeps in sync. `nodeInfoFor` composes the
  view from live labels each time; draining a node writes Docker availability,
  not a DB flag.
- **Edge roles + geography are Docker node labels**: `swarmy.node.ingress` /
  `swarmy.node.outlet` (this node accepts public traffic / serves as an egress
  outlet), `swarmy.region` (steering + region-aware upstreams),
  `swarmy.node.public-ip` (controller-stamped from the agent's detected IP,
  cross-checked against its connection source) with
  `swarmy.node.public-ip.override` always winning. Toggling a role in the UI
  patches the label; the edge data planes appear/drain by label constraint. See
  the `docker-native-storage` skill.
- **Per-node cost lives on the node itself** (`swarmy.node.cost.*` label) — "set
  a price, swarmy stores it on the node," so cost survives without a DB row and
  feeds per-stack breakdowns.
- **What swarmy's DB owns is only its own identity + credentials**: the `Node`
  row (org scoping, `nodeId`, hostname, `sessionSecretHash`, `sessionVersion`)
  and `JoinToken` (uses, expiry, revocation, label/role intent; only its hash
  is stored, and the plaintext is shown once at mint).
  Everything derivable about the machine is derived from swarm truth. Join
  tokens are also minted, listed and revoked over REST (`/api/v1/join-tokens`,
  the same guards as the dashboard) and by Terraform (`swarmy_join_token`).

## Dial-out behaviour (what "the agent dials out" commits us to)

- **One reconnecting outbound WebSocket per node.** The agent connects with a
  subprotocol, full-jitter backoff, and a stability timer that resets the
  attempt counter once a connection holds. It re-registers on every reconnect.
- **Join once, session thereafter — and the session is durable.** First contact
  authenticates with the join token (`kind:'join'`); the controller upserts the
  `Node`, increments the token's `uses`, and mints a fresh `sessionSecret`. From
  then on the agent reconnects with `kind:'session'`. **The session secret is
  rotated on every successful register** and `sessionVersion` increments; a newer
  session closes the older socket (`DUPLICATE_SESSION`). The session is persisted
  with retry + read-back verification so a reboot reconnects on its own, and the
  join token stays valid *for the one node it enrolled* (hostname **re-adoption**)
  as a durable fallback credential — so re-running the one-liner or a plain reboot
  always heals rather than stranding the node. "Single-use" therefore means
  single-*node*: a consumed token can re-authenticate its own box but can never
  enroll a new one, and revoking it is still the absolute kill switch. The full
  recovery story (repair one-liner, on-box `doctor`, the recovery beacon, rescue
  backups) lives in [`node-recovery.md`](./node-recovery.md).
- **Reads are not commands.** `list`/`inspect`/`stats` are served from the hub's
  in-memory snapshots the agent already streams (containers, services, nodes,
  metrics). Only mutations dispatch a command to the node. This keeps the
  dashboard instant and the socket quiet. The container snapshot also carries
  Docker's own health record for each running container with a check (status,
  miss streak, the effective test and the last probes Docker keeps), read at
  most once per 10 s per container or when its health word changes.
- **An agent out of step with the controller is named, not guessed at.** On
  every register the controller compares the agent's release and protocol
  versions with its own. A server whose agent is behind says so in plain words
  ("This server's agent is two versions behind") with **Upgrade agent**; an
  agent that is ahead says to upgrade swarmy. An agent that shares no protocol
  version with the controller is called out as unable to talk to swarmy (its
  frames won't parse, so it would otherwise look connected and do nothing),
  and the controller logs a warning. The judgement is held in memory and
  redone on every register; it is never stored.
- **The agent is useless off-swarm, and says so.** A swarm-membership watchdog
  exits the agent if the swarm is *left* out from under a running node (operator
  ran `docker swarm leave`, or the node was removed) — but only after seeing the
  swarm active at least once, so a freshly-enrolling node legitimately waits for
  the controller's `swarm.join`. On exit it sends a `swarmLeft` frame first, so
  the controller marks the node left-swarm and audits it rather than inferring a
  silent drop.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Node loses connectivity / box powers off | Socket closes; controller marks the node offline after the missed heartbeat. Its swarm services reschedule per Docker; the agent reconnects with backoff and re-registers when the box returns. |
| Operator runs `docker swarm leave` on a live node | Watchdog sends `swarmLeft`, then exits; container restarts and waits to rejoin. Controller marks it left-swarm + audits — never a phantom "healthy" member. |
| Controller down while a node is enrolling | The agent retries the outbound WSS with jittered backoff; nothing on the box needs the controller except registration. Once the controller returns, `register` completes. |
| Duplicate agent for one node (re-run installer) | Enrollment is idempotent: same hostname upserts (or **re-adopts**) the same `Node`; the newer session wins and the stale socket is closed. Re-running the one-liner switches to repair mode and never creates a duplicate. |
| Node reboots / loses its session file | The session was persisted durably (retry + read-back), so it reconnects on its own. If the session is gone, the env-file join token re-adopts the same node by hostname. |
| Node won't reconnect, machine is up | **Repair this node** in the dashboard (re-mints the one-liner) or `swarmy-agent doctor --fix` on the box. See [`node-recovery.md`](./node-recovery.md). |
| Repair one-liner re-run on an enrolled node | The mesh config moves as one unit: a line that brings a setup key brings the whole mesh config; one without a key keeps the node's saved config whole, including a `SWARMY_ALLOW_MESH=false` opt-out and its driver. A key the agent will ignore is warned about. |
| A node starts without joining the mesh | The daemon logs why in one line (mesh off on this node, or no setup key), and `doctor` reports a key the opt-out makes it ignore as a warning with the fix. |
| A dead manager address lingers in the swarm | `doctor`'s swarm rung probes every listed manager address and says whose record it is and the fix (a swarm rebuild for our own stale record; demote/remove, or fix the path, for another manager's) before new overlays break with "no VNI provided". |
| Node lost every credential (session + token) | The recovery beacon: the agent prints a fingerprint in its journal and posts a claim; a dashboard banner lets the operator approve it after matching the fingerprint (SSH-host-key trust). |
| Controller down, data at risk on a cut-off node | `swarmy-agent backup export`/`push` moves the node's volumes with zero controller contact. |
| Docker not yet installed / unavailable | Install script installs Docker first; a running agent that can't reach Docker still reports OS-only node facts and stays connected rather than crash-looping. |
| A service is moved to a server that can't take it | `decommission.moveService` checks every refusal before it starts (a global or multi-copy service, a managed Postgres primary, a move already running, an offline or draining destination, no named volumes) and returns the reason. Only then does the copy run in the background; its progress is the service's `swarmy.move.state` label and its outcome an audit row. |
| A manager dies / quorum is at risk | The Swarm health card + resilience score say it in plain words ("3 managers, 1 offline — one more failure loses quorum") before it becomes an outage. Promote/demote are quorum-guarded: swarmy refuses a demote that would leave the swarm headless or below majority. With autolock on, the unlock key is stored encrypted next to the join tokens (or shown once for self-storage) so a restarted manager can always be unlocked. |

## Explicitly rejected

- **Running the agent inside Docker as the primary install.** An agent that
  rides the thing it manages can't repair it: Docker breaks → the agent
  container breaks → nobody's left to fix Docker. The container backend
  exists only as a fallback for systemd-less hosts, and it is the degraded
  mode, not the model.
- **Controller-initiated SSH / Ansible / cloud-init push.** Requires the
  controller to hold node credentials and reach in — violating the dial-out,
  NAT-friendly, "controller never touches the node" principle. `curl | sh` is
  pull-based and works behind NAT with zero inbound ports.
- **Storing swarm join tokens at all.** Manager/worker SWMTKN tokens are read
  live from a manager when a node joins (cached vault-encrypted in controller
  memory only), rotatable (`rotateJoinTokens`), and handed to the box only for
  a local `swarm join`. The one swarm secret swarmy stores is the opt-in
  autolock unlock-key escrow (a vault-encrypted `VaultEntry` row).
- **A DB mirror of swarm state.** Role, availability, labels, and membership are
  read from Docker each time. A column that shadows swarm state drifts — see the
  `docker-native-storage` skill.
- **Making the user choose manager vs worker.** The token's role hint + the
  controller decide; the happy path asks nothing.
- **Bash, or config baked into the URL.** Bash excludes Alpine/busybox hosts,
  and a token in the URL leaks into logs. The pasted line stays one line: the
  token and a few optional env knobs, everything else resolved server-side.
- **A database service for the controller.** The controller's store is
  embedded SQLite (`control.db` + `telemetry.db` on the `swarmy-data` volume),
  so an install runs no Postgres, port or DB password. The old `--standard`
  Postgres tier and embedded PGlite were both removed; the reasons are in
  `resilience-and-dr.md` → "Reversed decisions".

## Onboarding (the one part we hand-hold)

The dashboard's "Add a server" flow is the only manual step, and it is guided: mint
or reuse a join token (optionally with labels + a role hint **and an install
profile** — Default / Edge / Storage / Database / Private-mesh; the profile is a
label bundle stamped once at enrollment, so an "edge" token yields a node that's
already an ingress edge, and a "private-mesh" token yields a node with no public
roles that auto-joins the org mesh when one is enabled — always just a starting
point the role switches can change), show the copy-paste
one-liner, and watch the node transition to ONLINE live. The installer is
two-stage on purpose — a tiny reviewable loader prints the pinned version +
checksums, then fetches a checksum-pinned installer and agent binary — so
`curl | sh` is honest: what you pipe to your shell is small, and everything it
downloads afterward is content-addressed. Re-running is safe and is the
supported **repair** path — on an already-enrolled box the installer detects the
existing install, refreshes the binary + credentials, keeps the node's identity
(hostname re-adoption), and runs the on-box doctor. The node installer's
`--uninstall` removes the agent and its state (`agent.json`, `agent.env` and the
other state files), the mesh client sidecar, its identity and the mesh pin; on
the node that runs the mesh control plane it stops unless `--keep-data` or
`--yes` is given. It doesn't rotate the swarm join tokens: a node never stores
one, a worker can't rotate them, and rotating from one manager would revoke the
live controller's. When a node won't come back, the
dashboard offers **Repair this node** on its detail page; the full ladder is in
[`node-recovery.md`](./node-recovery.md).

The self-host installer (`scripts/install-swarmy.sh`, which stands up the
controller itself) follows the same rules. A release's installer is stamped
from its signed `platform.json` with the controller and agent pinned as
`<repo>:<tag>@<digest>` and the release's stack file embedded
(`scripts/stamp-install-swarmy.ts`); `--image`, `--agent-image`, `SWARMY_REF`
and `SWARMY_RAW_BASE` override the pins with a warning, and an older installer
never rolls back a controller Settings › Platform already upgraded. The owner
password comes from `--admin-password-file` or stdin (`--admin-password -`),
never argv unless you insist (it warns). Generated secrets go to 0600 files in
the root-only state directory (`admin-password`, `add-node.txt`) and only their
paths are printed. The operator's original `/etc/docker/daemon.json` is backed
up once and never overwritten by a later step or re-run. `--uninstall` removes
node #1's agent and state, the stack and its secrets, the data and the mesh
(after a typed confirmation, or `--yes` with `--non-interactive`;
`--keep-data` keeps them) and rotates both swarm join tokens.

## Implementation map

The operational conventions and invariants live in two skills: `agent-handlers`
(`.claude/skills/agent-handlers/SKILL.md`) — how the agent executes commands and
how to add one — and `node-recovery` (`.claude/skills/node-recovery/SKILL.md`) —
the CLI/TUI, self-healing one-liner, re-adoption, and the recovery beacon (its
product doc is [`node-recovery.md`](./node-recovery.md); the operator runbook is
[`../NODE-RECOVERY.md`](../NODE-RECOVERY.md)). Key homes:
`apps/agent/src/main.ts` (binary entrypoint / CLI dispatch),
`apps/agent/src/daemon.ts` (dial-out, node facts, swarm watchdog, session
persistence, recovery beacon; `index.ts` is a back-compat daemon shim),
`apps/agent/src/cli/*` (CLI commands + the OpenTUI doctor),
`apps/agent/src/connection.ts` (reconnecting WS client),
`apps/agent/src/executor.ts` (command dispatch),
`apps/agent/src/handlers/*` (capabilities via `@swarmy/core/docker`),
`packages/core/src/protocol/*` (the wire contract),
`packages/trpc/src/hub/types.ts` (`CommandName` → wire `type`),
`apps/api/src/gateway/protocol-handlers.ts` (`register`/session handshake) +
`apps/api/src/gateway/join-auth.ts` (the re-adoption decision) +
`apps/api/src/gateway/agent-skew.ts` over `packages/core/src/protocol/skew.ts`
(the version-skew judgement),
`packages/trpc/src/services/volumeMove.service.ts` (`planServiceMove`, the move),
`packages/trpc/src/services/node.service.ts` (roles/region/public-ip labels,
drain), and the `apps/api/src/install/*` routes + `scripts/install-swarmy.sh`
for the install script (release pins `apps/api/src/install/self-host-pins.ts` +
`scripts/stamp-install-swarmy.ts`; the repair-mode mesh salvage
`apps/api/src/install/repair-env-sh.ts`). Join tokens over REST:
`packages/api-rest/src/routes/join-tokens.ts`.
