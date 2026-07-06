# Compute & onboarding — "paste one line, watch it come online"

**Status: canonical product design (2026-07). Pairs with the `agent-handlers`
skill for the how.**

## The feeling we are building

Someone with a swarmy account and a fresh Linux box should get from "empty VPS"
to "node ONLINE in the dashboard" with a single pasted line:

1. In the dashboard they open **Infrastructure → Add a node** (or Settings →
   Enroll a node) and copy the one-liner:
   `curl -fsSL https://app.swarmy.dev/i/<token> | sh`.
2. On the box they paste it. The script installs Docker if missing, installs the
   agent as a managed service, initializes or joins the org's Docker Swarm
   **locally**, and starts dialing out.
3. Within seconds the node appears on the **Infrastructure** canvas — hostname,
   role, cores, memory, live CPU/MEM — grouped under Control plane or Workers.
4. They flip its **ingress**/**outlet** switches, give it a **region**, set a
   monthly **cost**, and it starts carrying real traffic and showing up in
   per-stack cost breakdowns.

No SSH keys handed to a controller. No manager-vs-worker decision to agonize
over. No "install Docker, then build the agent, then set five env vars, then
`docker swarm init`." One line, and the machine joins the swarm. It should feel
like the box enrolled *itself* — because it did: **the agent dials out, the
controller never reaches in.**

## How it works (enrollment path)

```
fresh box                                       dashboard: "Add a node"
   │  ① curl https://app.swarmy.dev/i/<token> | sh
   │     token IS the config → resolves server-side to org, WSS URL, labels,
   │     role hint, pinned agent version + checksums
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
node ONLINE on the Infrastructure canvas
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
- **The token is the entire config.** The pasted URL carries an opaque bootstrap
  token; the controller resolves it to org, controller URL, desired labels, role
  hint, and the pinned agent version. The script *body* is identical for every
  user — only the URL differs — so it can be a static, signed, cacheable
  artifact. The token is the join token already in the DB, reused; no new secret
  type.
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
  row (org scoping, `nodeId`, hostname, `sessionSecretHash`, `sessionVersion`,
  `enrollMethod`) and `JoinToken` (uses, expiry, revocation, label/role intent).
  Everything derivable about the machine is derived from swarm truth.

## Dial-out behaviour (what "the agent dials out" commits us to)

- **One reconnecting outbound WebSocket per node.** The agent connects with a
  subprotocol, full-jitter backoff, and a stability timer that resets the
  attempt counter once a connection holds. It re-registers on every reconnect.
- **Join once, session thereafter.** First contact authenticates with the join
  token (`kind:'join'`); the controller upserts the `Node`, increments the
  token's `uses`, and mints a fresh `sessionSecret`. From then on the agent
  reconnects with `kind:'session'`. **The session secret is rotated on every
  successful register** and `sessionVersion` increments; a newer session closes
  the older socket (`DUPLICATE_SESSION`). The join token is single-use-effective
  — the installer shreds it from the env file after first register.
- **Reads are not commands.** `list`/`inspect`/`stats` are served from the hub's
  in-memory snapshots the agent already streams (containers, services, nodes,
  metrics). Only mutations dispatch a command to the node. This keeps the
  dashboard instant and the socket quiet.
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
| Duplicate agent for one node (re-run installer) | Enrollment is idempotent: same hostname upserts the same `Node`; the newer session wins and the stale socket is closed. |
| Docker not yet installed / unavailable | Install script installs Docker first; a running agent that can't reach Docker still reports OS-only node facts and stays connected rather than crash-looping. |
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
- **Storing swarm join tokens centrally.** Manager/worker join tokens are fetched
  and used locally on the box; swarmy does not warehouse them.
- **A DB mirror of swarm state.** Role, availability, labels, and membership are
  read from Docker each time. A column that shadows swarm state drifts — see the
  `docker-native-storage` skill.
- **Making the user choose manager vs worker.** The token's role hint + the
  controller decide; the happy path asks nothing.
- **Bash with `--flags`.** More to mistype and it pushes config to the client
  when the controller already knows everything. The token-resolves-to-config
  model keeps the pasted line to one line.

## Onboarding (the one part we hand-hold)

The dashboard's "Add a node" flow is the only manual step, and it is guided: mint
or reuse a join token (optionally with labels + a role hint), show the copy-paste
one-liner, and watch the node transition to ONLINE live. The installer is
two-stage on purpose — a tiny reviewable loader prints the pinned version +
checksums, then fetches a checksum-pinned installer and agent binary — so
`curl | sh` is honest: what you pipe to your shell is small, and everything it
downloads afterward is content-addressed. Re-running is safe; `systemctl disable
--now` (or removing the container) uninstalls cleanly.

## Implementation map

The operational conventions and invariants live in the `agent-handlers` skill
(`.claude/skills/agent-handlers/SKILL.md`) — how the agent executes commands and
how to add one. Key homes: `apps/agent/src/index.ts` (dial-out, node facts,
swarm watchdog, heartbeat/metrics loops), `apps/agent/src/connection.ts`
(reconnecting WS client), `apps/agent/src/executor.ts` (command dispatch),
`apps/agent/src/handlers/*` (capabilities via `@swarmy/core/docker`),
`packages/core/src/protocol/*` (the wire contract),
`packages/trpc/src/hub/types.ts` (`CommandName` → wire `type`),
`apps/api/src/gateway/protocol-handlers.ts` (`register`/session handshake),
`packages/trpc/src/services/node.service.ts` (roles/region/public-ip labels,
drain), and the `apps/api` install routes + `plans/epic-node-onboarding.md` for
the install script.
