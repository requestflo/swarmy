---
name: agent-handlers
description: How the swarmy agent works and how to add or change an agent capability — the dial-out WebSocket, the register/session handshake, the command envelope + executor dispatch, and the handler↔@swarmy/core/docker boundary. Load before touching apps/agent, packages/core/src/protocol, the hub CommandName registry, or apps/api/src/gateway (register/session). Product rationale lives in docs/product/compute-and-onboarding.md.
---

# Agent handlers: dial-out, commands, and the docker boundary

Read `docs/product/compute-and-onboarding.md` for WHY the agent dials out and
enrollment is one line. This skill is the HOW: the invariants every agent change
must keep, and where everything lives. For adding a full feature slice
(db → protocol → service → router → UI) see `skill("add-feature-slice")`; this
skill is the agent-and-protocol third of that.

> The agent binary is also an operator CLI/TUI, and it self-heals when a node
> goes dark (repair one-liner, hostname re-adoption, recovery beacon, on-box
> `doctor`). That layer — the CLI dispatch in `main.ts`, `daemon.ts`, the
> `cli/*` commands, `join-auth.ts`, and `recovery.service.ts` — is owned by
> `skill("node-recovery")`. Load it before touching those; this skill stays
> focused on the dial-out/command/handler core underneath.

## Invariants (violating any of these is a bug, not a style choice)

1. **The agent dials OUT; the controller never connects IN.** All node work
   happens on the agent against its LOCAL Docker socket. Never add a path where
   the controller reaches a node's Docker socket, opens an inbound port, or SSHes
   in. Swarm `init`/`join` run locally on the box (`swarm.join` command), never
   controller-initiated against a remote socket.
2. **Reads are NOT commands.** `list`/`inspect`/`stats` are served from the hub's
   in-memory snapshots the agent streams (containers, services, nodes, metrics).
   Only a MUTATION dispatches a `CommandName`. If you're about to add a command
   just to read state, stop — surface it from the snapshot instead. Docker's
   health record is the pattern: the container snapshot folds in `State.Health`
   (`ContainerInfo.health`, optional; `apps/agent/src/health-probes.ts`) for
   running containers with a check — one inspect per container per 10 s at
   most, sooner when its health word changes, ≤ 32 per tick, best-effort — and
   `services.healthProbes` reads it with no dispatch. "Test now"
   (`services.testHealthcheck`) reuses the existing `exec` command behind the
   exec gate rather than adding one.
3. **Every command is one entry in three places, in this order:** (a) a Zod
   message in `packages/core/src/protocol/*` added to the `ControllerToAgentMessage`
   union in `messages.ts`; (b) a `CommandName` + its wire `type` in
   `COMMAND_PROTOCOL_TYPE` (`packages/trpc/src/hub/types.ts`); (c) a `case` in
   the agent's `executor.ts` switch. Miss one and the command is unroutable or
   unparseable. Reads/telemetry frames are the reverse direction and do NOT go in
   `COMMAND_PROTOCOL_TYPE`.
4. **Command payloads carry a `commandId`; the agent answers exactly once with
   `commandResult`.** Wrap side-effecting work in the `run(conn, commandId, fn)`
   helper so success → `{ status:'success', result }` and throw →
   `{ status:'failed', error:{ code, message } }`. Streaming commands
   (`logs.subscribe`, `exec`, terminal) emit their own frames (`logChunk`, term
   frames) and manage cancellation via `activeLogStreams`/session maps. Never
   leave a `commandId` unanswered.
5. **After a mutation that changes inventory, push inventory.** Deploy/scale/
   restart/remove/updateLabels call `pushInventory(docker, conn)` so the hub
   snapshot (and the dashboard) reflect the change without polling the socket.
6. **Handlers are thin over `@swarmy/core/docker`.** All Docker/dockerode calls
   go through `DockerClient` (`@swarmy/core/docker`); handlers in
   `apps/agent/src/handlers/*` orchestrate, they don't re-implement dockerode.
   Logic shared with the controller (spec building, compose parsing) lives in
   `packages/core`, imported by both — never inline a copy in a handler.
7. **The wire envelope is fixed: `{ v, id, ts, type, payload }`.** Parse every
   inbound frame with `parseControllerEnvelope` (Zod) and drop unparseable
   frames silently. Bump `PROTOCOL_VERSION` when the contract changes; the agent
   advertises `protocolVersions` in its facts. The controller judges skew on
   EVERY register (`judgeAgentSkew` → pure `agentSkew` in
   `@swarmy/core/protocol`): `incompatible` when the agent shares none of
   `SUPPORTED_PROTOCOL_VERSIONS` (logged as a warning: the node looks
   connected but its frames won't parse), else `behind`/`ahead` by semver
   (the newest protocol decides for non-semver dev builds), else `ok`. The
   result lives in the gateway store's `agentBuild` entry (process memory,
   re-judged per register — never a DB column or a label) and reaches the
   dashboard as `NodeSummary.agentSkew`. When a new protocol version lands
   beside the old one, WIDEN `SUPPORTED_PROTOCOL_VERSIONS`; never narrow it.
   An ADDITIVE command (one an older agent would drop as unparseable) is not
   a protocol bump (that changes the WS subprotocol): list it in
   `AGENT_CAPABILITIES` (`protocol/capabilities.ts`, append only). The agent
   advertises them in `NodeFacts.capabilities`, the gateway keeps them in
   `agentBuild`, and the controller dispatches only when
   `agentSupports(ctx.hub.agentBuildFor?.(id)?.capabilities, …)`, falling
   back to the old behaviour otherwise (`dbPitrWindow` is the reference).
8. **Auth is join-once, session-thereafter, and rotates every register.** First
   contact uses `{ kind:'join', joinToken }`; thereafter `{ kind:'session',
nodeId, sessionSecret }`. The controller mints a NEW `sessionSecret` (and
   bumps `sessionVersion`) on EVERY successful register and closes any older
   socket (`DUPLICATE_SESSION`). Never persist the join token past first
   register; never return a session secret to a client.
9. **The agent must not run off-swarm.** Keep the swarm watchdog: on an
   active→inactive transition, send `swarmLeft` then exit (so the node drops
   offline / restarts and the controller audits it) — but never exit a
   node that has not yet joined (freshly-enrolling nodes wait for `swarm.join`).
10. **Every privileged capability has its OWN gate: a controller-asserted node
    label plus a local env veto** (`apps/agent/src/env.ts`, gate fns in
    `@swarmy/core`). Container exec is default-ON — the real gate is
    controller-side (`terminal.open` ABAC + TerminalPolicy + audit + recording);
    `swarmy.node.exec=false` turns it off and `SWARMY_ALLOW_EXEC` is a tri-state
    override; its local veto (`false`) also refuses `dbQuery`, `queueOp` and
    `appDb*`, which run a client inside a task (`execVetoed`, proven by
    `executor-veto.test.ts`). `runOnce` mounts only the bind shapes swarmy's own
    one-shots use (`@swarmy/core/protocol` `run-once-binds.ts`: named volumes at
    safe paths, the Docker socket for the docker-CLI image, a node restic repo
    for the restic image) and answers anything else `E_BIND_REFUSED` before it
    pulls or creates. Node shell (host RCE) is default-OFF: only `swarmy.node.shell=true`
    enables it, `SWARMY_ALLOW_NODE_SHELL=false` vetoes locally and `true` can NOT
    force it on. Builds follow the `swarmy.node.builder` role
    (`SWARMY_ALLOW_BUILD` override); mesh is on unless `SWARMY_ALLOW_MESH=false`.
    Terminals are output-capped (`SWARMY_TERM_MAX_OUTPUT_BYTES`, 64 MiB). A new
    privileged handler adds its own gate — it never rides or widens another's.

## Contracts between the layers

- **Controller → agent dispatch**: `ctx.hub.dispatch(nodeId, cmd, payload)` where
  `cmd` is a `CommandName`; the hub maps it to the wire `type` via
  `COMMAND_PROTOCOL_TYPE` and sends `{ v,id,ts,type,payload }` down the node's
  socket. Services never hand-roll the wire frame.
- **Agent → controller telemetry**: `conn.send(type, payload)` for `register`,
  `heartbeat`, `metrics`, container/service/node snapshots, `meshState`,
  ingress status, `publicIp`, and command results. The hub keeps the latest
  snapshot per node in memory; tRPC reads serve from it.
- **Register handshake** (`apps/api/src/gateway/protocol-handlers.ts`): socket
  starts `await_register`; first frame must be `register` or the socket closes.
  `join` → upsert `Node` (keyed `orgId_name` on hostname), increment token
  `uses`, mint session, `registerAck { nodeId, sessionCredential,
heartbeatIntervalMs, metricsIntervalMs }`. `session` → verify
  `sessionSecretHash`, rotate, ack.
- **Result shape**: `commandResult { commandId, status:'success'|'failed'|
'canceled', result?, error?:{ code, message } }`. Error codes are stable
  machine strings (`E_DOCKER`, `E_NOT_MANAGER`, …) — services branch on them.

## File map

| Concern                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary entrypoint: CLI dispatch (`--version`, TTY→TUI, no-args→daemon)                                                                                                                                                                                                                                                                        | `apps/agent/src/main.ts` (see `skill("node-recovery")`)                                                                                                                                                                                   |
| Dial-out daemon: facts, watchdog, heartbeat/metrics loops, session persist                                                                                                                                                                                                                                                                    | `apps/agent/src/daemon.ts` (`index.ts` is a back-compat shim)                                                                                                                                                                             |
| Reconnecting WS client (backoff, register on open, `redial()`)                                                                                                                                                                                                                                                                                | `apps/agent/src/connection.ts`                                                                                                                                                                                                            |
| Command dispatch (switch on envelope `type`) + `run()`                                                                                                                                                                                                                                                                                        | `apps/agent/src/executor.ts`                                                                                                                                                                                                              |
| Capabilities (deploy/mesh/dns/backup/build/storage/terminal/…)                                                                                                                                                                                                                                                                                | `apps/agent/src/handlers/*`                                                                                                                                                                                                               |
| Web terminal: exec/node-shell PTY over the agent WS, tickets, recording                                                                                                                                                                                                                                                                       | `apps/agent/src/handlers/terminal.ts`, `protocol/terminal.ts`, `apps/api/src/terminal{,-tickets,-recording}.ts`, `schema/terminal.prisma`                                                                                                 |
| Node facts, public-IP detect, snapshots, stats                                                                                                                                                                                                                                                                                                | `apps/agent/src/{public-ip,snapshots,stats,state}.ts`                                                                                                                                                                                     |
| Docker health probes on the container snapshot                                                                                                                                                                                                                                                                                                | `apps/agent/src/health-probes.ts`; pure `packages/core/src/container-health.ts`, edit/test shapes `packages/core/src/healthcheck.ts`                                                                                                      |
| Volume sizes (`/system/df?type=volume` every 10 min, cached; additive `metrics.volumes`, sent once per measurement + after register; hub memory only → `nodes.volumeSizes`)                                                                                                                                                                   | `apps/agent/src/volume-sizes.ts`; pure `packages/core/src/volume-sizes.ts`, wire `protocol/volume-sizes.ts`; `packages/trpc/src/services/volume-sizes.service.ts`                                                                         |
| Local exec veto + runOnce bind allowlist                                                                                                                                                                                                                                                                                                      | `apps/agent/src/executor.ts` (`execVetoed`), `packages/core/src/protocol/run-once-binds.ts`; tests `apps/agent/src/executor-veto.test.ts`                                                                                                 |
| Byte streams agent → controller (credit flow; the only binary WS frames, sent only for a stream the controller started): `streamCredit`/`streamCancel`/`streamEnd`, chunk frame codec, pure sender/receiver; first user `snapshotDump` (local veto `SWARMY_ALLOW_SNAPSHOT_DOWNLOAD=false`, node ceiling `SWARMY_SNAPSHOT_DOWNLOAD_MAX_BYTES`) | `packages/core/src/protocol/{stream,stream-frame,stream-flow}.ts`; agent `AgentConnection.sendBinary`, `handlers/{dump-pump,sidecar-stream,snapshot-dump}.ts`; gateway `handleAgentBinary` → `apps/api/src/downloads/download-hub.ts`     |
| Why a node skipped the mesh-first join (logged, shown by `doctor`)                                                                                                                                                                                                                                                                            | `apps/agent/src/mesh-startup.ts` (`meshSkipReason`)                                                                                                                                                                                       |
| Wire protocol: envelope, messages, auth, per-domain types                                                                                                                                                                                                                                                                                     | `packages/core/src/protocol/*`                                                                                                                                                                                                            |
| Docker/dockerode wrapper (single source)                                                                                                                                                                                                                                                                                                      | `@swarmy/core/docker` (`packages/core/src/docker.ts`)                                                                                                                                                                                     |
| `CommandName` → wire `type` registry                                                                                                                                                                                                                                                                                                          | `packages/trpc/src/hub/types.ts` (`COMMAND_PROTOCOL_TYPE`)                                                                                                                                                                                |
| Controller-side dispatch / snapshot hub                                                                                                                                                                                                                                                                                                       | `packages/trpc/src/hub/*`, `packages/trpc/src/services/dispatch.service.ts`                                                                                                                                                               |
| Register / session handshake                                                                                                                                                                                                                                                                                                                  | `apps/api/src/gateway/protocol-handlers.ts`                                                                                                                                                                                               |
| Agent ↔ controller version skew (pure rule; register-time judge; per-node build facts)                                                                                                                                                                                                                                                        | `packages/core/src/protocol/skew.ts` (+ `SUPPORTED_PROTOCOL_VERSIONS` in `constants.ts`), `apps/api/src/gateway/agent-skew.ts`, `apps/api/src/gateway/store.ts` (`agentBuild`); UI `apps/app/src/components/nodes/servers/agent-skew.tsx` |
| Node roles/region/public-ip labels, drain                                                                                                                                                                                                                                                                                                     | `packages/trpc/src/services/node.service.ts`                                                                                                                                                                                              |
| Install script routes + agent binary serving                                                                                                                                                                                                                                                                                                  | `apps/api/src/install/*`, `scripts/install-swarmy.sh` (WHY: `docs/product/compute-and-onboarding.md`)                                                                                                                                     |

## Adding a command (the recipe)

1. **Message** in `packages/core/src/protocol/<domain>.ts`: a `z.object` payload
   with `commandId` (+ `timeoutMs?`); add it to the `ControllerToAgentMessage`
   union in `messages.ts`.
2. **Registry**: add the `CommandName` and its wire `type` to
   `COMMAND_PROTOCOL_TYPE` in `packages/trpc/src/hub/types.ts`.
3. **Executor**: add a `case '<type>'` in `apps/agent/src/executor.ts` that
   destructures `envlp.payload`, wraps work in `run(conn, commandId, …)`, and
   calls a handler in `apps/agent/src/handlers/`. Push inventory if it mutates.
4. **Handler**: implement against `DockerClient`; keep shared logic in
   `packages/core`.
5. **Dispatch it** from a service via `ctx.hub.dispatch(nodeId, '<CommandName>',
payload)` — org-scoped, audited (see `skill("add-feature-slice")`).

## Operational gotchas

- Node-fact detection and public-IP detection must never block startup — the
  agent reports OS-only facts if Docker is unavailable and keeps the socket up.
- A command that can hang needs a `timeoutMs` and a handler that respects it;
  a wedged handler blocks nothing else (each command is independent) but leaves a
  `commandId` unanswered — always answer, even on timeout.
- Don't add a mutating route to any node-local admin API without a bearer gate
  (the DNS admin API is the pattern — see `skill("geo-edge-routing")`).
- A worker's container agent sits on the default bridge, so its own routes and
  addresses are the CONTAINER's (172.17.0.x), not the host's. Never hand Docker
  an address derived inside it: the swarm advertise address is pinned only when
  `agentOnHostNetwork()` (`handlers/swarm-advertise.ts`), else dockerd picks it.
  A wrong one still shows Ready but kills cross-node DNS and overlay traffic.
- Verify: `bun --filter @swarmy/agent typecheck` and the protocol round-trip
  tests (`parseControllerEnvelope` over your new message); after a protocol
  bump, also `packages/core/src/protocol/skew.test.ts` and
  `apps/api/src/gateway/agent-skew.test.ts`. Multi-node behaviour:
  `scripts/local-vms.sh` (see `skill("run-local")` + LOCAL-SWARM.md) — enroll a
  VM, watch it reach ONLINE, `docker swarm leave` and watch `swarmLeft` fire.
