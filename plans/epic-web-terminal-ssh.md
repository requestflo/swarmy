# Epic: Web SSH / terminal proxy into nodes & containers

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11 over Hono, Prisma 7/Postgres, Better Auth + org plugin, agent dial-out WS, `@swarmy/core` wire protocol). Do not redesign the scaffold; this epic plugs into it.

## Problem

Operators need a browser terminal that reaches two distinct targets on a swarm node, from the swarmy dashboard, through the controller, without opening any inbound port on the node:

1. **Container exec** — an interactive shell (or arbitrary command) inside a running container (`docker exec -it <ctr> sh`). This is the 90% case: "my app is misbehaving, let me poke at it." It is also the easy case — dockerode already gives us a duplex exec stream over the node's Docker socket, which the agent already holds.
2. **Node shell** — an interactive shell *on the host* (the machine running the agent). This is the dangerous, full-RCE case: it is effectively root on the box. Needed for break-glass debugging (disk full, daemon wedged, network broken) but must be far more gated than container exec.

Both must travel **the existing outbound agent WebSocket** — the controller never dials the node, the node dials out (NAT-friendly, zero inbound firewall rules). That is the whole architectural premise of swarmy and it is exactly what makes a hosted web terminal valuable: you get SSH-grade access to boxes behind NAT/CGNAT with nothing exposed.

This is **the single highest-risk feature in the product**: it is a remote-code-execution path by design, multi-tenant, and reachable from the public dashboard. The plan is therefore as much about the security envelope (RBAC, the `SWARMY_ALLOW_EXEC` gate, approval/MFA, audit, session recording, idle/output limits) as about the transport and the xterm.js frontend.

The existing scaffold gives us most of the plumbing but it stops short in three telling places:
- `commands.ts → ExecCommandMsg` exists but is **one-shot** (a `cmd[]` array, `tty`/`stream` booleans) and the agent's `execCommand` handler is a **stub that always returns `E_EXEC_DISABLED`** even when `SWARMY_ALLOW_EXEC=true`. There is no resize, no stdin, no node-shell at all.
- The wire protocol is **command-in / result-and-logChunk-out**. There is *no controller→agent streaming-input* message and no generic agent-managed *session* concept beyond the log-stream lifecycle (`streamLogs start/stop` correlated by `commandId`). An interactive PTY needs bidirectional, long-lived, mid-session control (resize, stdin, signals).
- The browser tRPC client uses **`httpSubscriptionLink` (SSE) — strictly one-way (server→client)**. Subscriptions stream *down* fine, but there is no upstream channel for keystrokes. There is no `wsLink` and the controller's tRPC handler is HTTP-only (`fetchRequestHandler`). So an interactive terminal needs a deliberate browser↔controller transport decision, not just "add a subscription."

## Recommended approach

### Decision 1 — Tunnel a **PTY over the existing agent WS**. Do **not** proxy SSH.

Run an interactive **pseudo-terminal on the node**, framed as new protocol messages, multiplexed over the agent's single outbound WebSocket. Reject the "SSH-over-mesh" alternative.

Why PTY-over-WS, concretely:
- **The agent already holds the only privileged handle we need.** For container exec, dockerode's `container.exec({ AttachStdin, AttachStdout, Tty })` + `exec.start({ hijack: true, stdin: true })` returns a duplex stream and `exec.resize({h,w})` handles SIGWINCH. For node shell, `Bun.spawn` / `node-pty` gives a host PTY. No new listener, no new port, no second daemon.
- **One transport, one auth, one audit choke point.** Reusing `/agent/ws` means the PTY inherits the join-token/session-secret auth, the connection registry, the org scoping, and the close-code semantics already built in `gateway/`. We add message *types*, not a new attack surface.
- **NAT-friendly by construction** — same dial-out socket; nothing about the terminal changes the firewall story.

Why **not** SSH proxying (sshd on the node + the controller bridging a TCP stream to it):
- It reintroduces a second credential system (host SSH keys / PAM users) orthogonal to swarmy's org RBAC — now you have two auth models to audit and two ways to get owned. Our auth/audit/recording would sit *outside* the SSH stream (we'd be proxying opaque encrypted bytes), so **session recording and command-level policy become impossible** without an MITM that defeats the point of SSH.
- It assumes sshd exists/*is configured* on every node and that container exec works through it (it doesn't — container exec is a Docker API, not SSH). We'd end up building PTY-over-WS for containers *anyway*, then bolting SSH on for nodes — two mechanisms.
- It breaks the "unopinionated, zero-config" promise: we'd be telling users to manage host SSH.
- The dial-out inversion is awkward for SSH (SSH is client-dials-server; our node is the dialer). Doable with reverse tunnels, but that's a mesh-VPN project, not a terminal.

The one genuine SSH win — **a real `ssh` client in your laptop terminal, not a browser** — we preserve as a *later* phase via a thin `swarmy ssh <node>` CLI that opens the same PTY protocol over the controller and bridges it to local stdin/stdout (ProxyCommand-style). Same backend, no sshd on nodes. (See MVP vs later.)

### Decision 2 — Browser transport: a **dedicated controller WebSocket endpoint for terminals** (`/term/ws`), *not* a tRPC subscription.

This is the load-bearing transport call and it diverges from how `liveStats`/logs work, deliberately.

- tRPC subscriptions in this scaffold ride **`httpSubscriptionLink` (SSE)**, which is **server→client only**. A terminal is duplex (keystrokes up, output down) and latency-sensitive. Forcing it through SSE-down + a separate `mutation`-per-keystroke up would be a latency and ordering disaster.
- Switching the whole app to `wsLink` for tRPC is a bigger, riskier change (it touches every subscription and the auth story for tRPC-over-WS) and still wraps each PTY byte in tRPC/superjson framing overhead.
- So: add a **purpose-built browser-facing WebSocket** on the controller, `GET /term/ws`, alongside `/agent/ws`. It speaks a tiny terminal framing (see protocol below), authenticates via the **Better Auth session cookie** (validated at upgrade using `auth.api.getSession({ headers })`, the same call `createContext` already makes) plus a **short-lived, single-use session ticket minted by a tRPC mutation** (defends against cookie-less WS edge cases and CSRF-on-WS, and is where MFA/approval is enforced — see security).
- tRPC still owns **session lifecycle and policy**: `terminal.open` (mutation → returns a ticket + sessionId after RBAC/MFA/approval checks), `terminal.list`, `terminal.close`, `terminal.recording.get`. The raw byte pipe is the dedicated WS. Clean split: **tRPC = control plane (typed, audited, policy), `/term/ws` = data plane (bytes).**

So the end-to-end path is:

```
xterm.js ──/term/ws (cookie + ticket)──▶ controller TerminalHub
   ▲                                          │  (correlate by sessionId)
   │ output frames                            ▼  ptyStart/ptyStdin/ptyResize/ptySignal
   └────────────────── controller ◀──/agent/ws── agent (dockerode exec | host PTY)
                        ptyOutput/ptyExit ───────┘
```

### Decision 3 — Frontend: **xterm.js** (`@xterm/xterm`) + `@xterm/addon-fit` + `@xterm/addon-attach`-style thin binding + `@xterm/addon-webgl`.

Industry-standard (VS Code, the Docker/Portainer/k8s dashboards all use it), maintained under the `@xterm/*` scope, framework-agnostic so it drops into the existing React 19 + Vite + shadcn dashboard as one `<Terminal>` component. We write our own ~30-line attach binding (xterm `onData` → WS send; WS message → `term.write`) rather than `addon-attach` so we control framing, backpressure, and resize. `addon-fit` + a `ResizeObserver` drives `ptyResize`. WebGL renderer for throughput on noisy output. Alternatives (hterm, plain `<pre>`) are strictly worse and unmaintained or non-interactive.

## Architecture & integration

### New protocol messages (`packages/core/src/protocol/terminal.ts`, exported via `protocol/index.ts`)

These are interactive-session messages, distinct from the one-shot `execCommand`. They are correlated by a new **`sessionId`** (a `MessageId`/uuid), *not* `commandId`, because a PTY is a long-lived bidirectional session, not a request→result. Add them to the two discriminated unions in `protocol/messages.ts`.

**Controller→agent** (add to `ControllerToAgentMessage`):

- `ptyStart` — open a session.
  ```ts
  PtyStartPayload = z.object({
    sessionId: SessionId,                       // = MessageId
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('container'),
                 containerId: z.string(),
                 // attach to an existing process? no — exec a new one:
                 cmd: z.array(z.string()).default([]),   // [] ⇒ agent picks: try bash, fall back to sh
                 user: z.string().optional(),
                 workdir: z.string().optional(),
                 env: z.record(z.string()).optional() }),
      z.object({ kind: z.literal('nodeShell'),
                 cmd: z.array(z.string()).default([]),    // [] ⇒ login shell ($SHELL || /bin/sh -l)
                 user: z.string().optional() }),          // host user; default = agent's uid
    ]),
    tty: z.boolean().default(true),
    cols: z.number().int().positive().default(80),
    rows: z.number().int().positive().default(24),
    term: z.string().default('xterm-256color'),
    idleTimeoutMs: z.number().int().nonnegative().default(300_000),
  })
  ```
- `ptyStdin` — `{ sessionId, seq, data, encoding: 'base64' }`. **base64 always** (terminal input is binary; do not try to keep it utf8 like logChunk does).
- `ptyResize` — `{ sessionId, cols, rows }`.
- `ptySignal` — `{ sessionId, signal: z.enum(['SIGINT','SIGTERM','SIGKILL','SIGHUP']) }` (Ctrl-C is sent as input bytes; this is for out-of-band kill / the UI "terminate" button).
- `ptyClose` — `{ sessionId }` (controller-initiated teardown: user closed tab, admin killed session, policy timeout).

**Agent→controller** (add to `AgentToControllerMessage`):

- `ptyStarted` — `{ sessionId, ok: true } | { sessionId, ok: false, error: {code,message} }`. Error codes: `E_EXEC_DISABLED`, `E_NODE_SHELL_DISABLED`, `E_NO_SUCH_CONTAINER`, `E_NO_SHELL` (no bash/sh in image), `E_SPAWN`.
- `ptyOutput` — `{ sessionId, stream: 'stdout'|'stderr', seq, data, encoding: 'base64' }`. (With a TTY, stdout/stderr are merged → always `stdout`; the `stream` field is kept for the non-tty exec case.)
- `ptyExit` — `{ sessionId, exitCode: z.number().nullable(), signal: z.string().optional(), reason: z.enum(['exit','idle_timeout','killed','agent_shutdown','error']) }`.

Notes that keep this consistent with the existing protocol:
- Reuse the **envelope** (`v/id/ts`) and `createEnvelope`. No changes to `primitives.ts` except adding `export const SessionId = MessageId`.
- Honor `MAX_MESSAGE_BYTES` (1 MiB). Add `MAX_PTY_CHUNK_BYTES = 32_768` to `constants.ts`; the agent splits larger output, like `MAX_LOG_CHUNK_BYTES`. Carry `seq` for ordering/gap-detection on both directions.
- Add `'pty'` close codes if needed; reuse `CloseCode` for the agent WS. For `/term/ws` define a small `TermCloseCode` set (`4401 unauthorized`, `4403 forbidden`, `4404 session gone`, `4408 idle`, `4409 superseded`).
- **Why a new message family vs. extending `execCommand`:** `execCommand`'s shape (one `cmd[]`, a single `commandResult`, `logChunk` out) is a request/reply with output, not a session with mid-flight stdin/resize. Keep `execCommand` for non-interactive one-shots (it's referenced in `CommandResultMap`, `DEFAULT_COMMAND_TIMEOUTS`, the hub's `CommandName='exec'`). PTY is its own thing. We will, however, **un-stub** `execCommand` for the non-interactive case as a freebie (run command, stream `logChunk`, return `{exitCode}`), since the agent gains the dockerode-exec plumbing anyway.

### Agent capabilities (`apps/agent`)

- New `apps/agent/src/pty.ts` managing a `Map<sessionId, PtySession>`. A `PtySession` owns the duplex stream, a write side, a `resize(cols,rows)`, a `kill(signal)`, and idle-timeout + max-output guards.
  - **Container target:** `docker.getContainer(id).exec({ Cmd, AttachStdin:true, AttachStdout:true, AttachStderr:true, Tty, User, WorkingDir, Env })`, then `exec.start({ hijack:true, stdin:true })` → duplex stream. `exec.resize({h:rows,w:cols})`. On `[]` cmd, probe order `['/bin/bash','-l'] → ['/bin/sh']`; if neither, `ptyStarted{ok:false, E_NO_SHELL}`. With `Tty:true`, output is a single stream (don't demux); with `Tty:false`, demux via `docker.modem.demuxStream`.
  - **Node shell target:** `node-pty` (`pty.spawn(shell, args, {name:'xterm-256color', cols, rows, cwd, env})`) for a real host PTY (job control, `clear`, vim work). `node-pty` is a native module — vendor a prebuilt for the agent's target arch in the agent image, or fall back to `Bun.spawn` with a PTY shim. Gated hard (see security).
- New methods on `DockerClient` (`packages/core/src/docker.ts`): `execInteractive(containerId, opts)` returning `{stream, resize, inspectExit}` and a `containerHasShell(id, candidates)` probe. Keeps dockerode confined to `@swarmy/core` per the existing rule (controller never imports it).
- `executor.ts`: replace the `execCommand` stub. Route the new `pty*` messages to `pty.ts`. Both targets respect gates: container exec requires `SWARMY_ALLOW_EXEC=true` (existing `env.ALLOW_EXEC`); node shell requires a **new, separate** `SWARMY_ALLOW_NODE_SHELL=true` (default false) in `apps/agent/src/env.ts` — node shell is strictly more dangerous than container exec and must not be enabled by the same flag.
- Backpressure: if the browser is slow, the controller signals the agent to pause (the agent pauses the source stream / stops reading the exec socket) — implement as a simple high-water-mark on the controller's per-session buffer that, when exceeded, drops a `ptyFlow{sessionId, paused}` control or just stops draining (TCP/WS backpressure naturally propagates). MVP: rely on WS backpressure + a hard per-session output-rate cap that kills runaway output (`yes`-bomb protection) with `ptyExit{reason:'killed'}`.

### Controller (`apps/api`)

- New `apps/api/src/terminal/` mirroring `gateway/`:
  - `hub.ts` — `TerminalHub`: a `Map<sessionId, TermSession>` linking a **browser socket** ↔ a **node (via the agent registry)**. Reuses the existing `ConnectionRegistry`/`AgentHubImpl` to `registry.send(nodeId, frame('ptyStart', …))` and routes inbound `ptyOutput/ptyStarted/ptyExit` (received by the *agent* protocol handler) into the matching browser socket. Wire it in by extending `gateway/protocol-handlers.ts` to recognize the three new agent→controller pty messages and hand them to `TerminalHub.onAgentFrame(sessionId, …)` — exactly how `commandResult`→`hub.settleCommand` and `logChunk`→`hub.emitLog` already work.
  - `index.ts` — the `/term/ws` upgrade + browser-side handlers (`open/message/close`), validating the **session ticket** on connect and binding `ws.data = { sessionId, orgId, userId, nodeId, target }`.
  - `tickets.ts` — in-memory, single-use, ~30s-TTL ticket store keyed to `{sessionId, userId, orgId}`.
- `apps/api/src/index.ts`: add `if (url.pathname === '/term/ws')` upgrade branch next to `/agent/ws`, with a distinct `websocket` handler set (Bun allows one `websocket` config per `serve`; route inside `message/open/close` by a discriminant on `ws.data`, or run the terminal handlers by branching on `ws.data` kind). Set `maxPayload: MAX_MESSAGE_BYTES`.
- **Session recording**: every `ptyStdin` (optionally) and every `ptyOutput` (always) is appended, server-side, to a recording sink as it passes through `TerminalHub` — the controller is the natural choke point (it sees both directions and the identity). Store as asciicast v2 (the `asciinema` format: a JSON header line + `[delta, "o"|"i", data]` event lines) so recordings are replayable with off-the-shelf `asciinema-player` in the dashboard and downloadable. Sink target = the volumes/object-store epic's blob store if present, else a local path / Postgres `bytea` for small sessions. Recording is **mandatory and non-disableable for nodeShell**, default-on and org-configurable for container exec.

### Database models (`packages/db/prisma/schema.prisma`)

- `TerminalSession`:
  ```
  id (cuid) | orgId | actorId(userId) | nodeId | targetKind('container'|'nodeShell')
  containerId? | command(Json) | startedAt | endedAt? | exitCode? | reason?
  recordingRef? | bytesIn Int | bytesOut Int | clientIp? | approvedById?
  @@index([orgId, startedAt]) @@index([nodeId])
  ```
  org-scoped like every other model; FK to `Organization` (+ relation back, like `auditLog`).
- `TerminalPolicy` (org-scoped, one per org, all defaults safe):
  ```
  orgId(unique) | containerExecEnabled Bool@default(true)
  nodeShellEnabled Bool@default(false) | requireMfa Bool@default(true)
  requireApprovalForNodeShell Bool@default(true) | recordContainerExec Bool@default(true)
  idleTimeoutMs Int@default(300000) | maxSessionMs Int@default(3600000)
  allowedRoles Json@default('["owner","admin"]')   // who may open at all
  ```
- `TerminalApproval` (for the four-eyes/break-glass flow on node shell): `id|orgId|requestedById|nodeId|reason|status(pending|approved|denied|expired)|approvedById?|expiresAt`.
- Every open/keystroke-policy-decision/close also writes the existing **`AuditLog`** (`action: 'terminal.open' | 'terminal.deny' | 'terminal.close' | 'terminal.approve'`, `targetType:'node'|'container'`, `metadata` = sessionId, command, reason). `AuditLog` already exists and is the system-wide audit trail; `TerminalSession` is the richer first-class record.

### tRPC router (`packages/trpc/src/routers/terminal.ts`, mounted in `root.ts`)

- `terminal.open` — `mutation`, input `{ nodeId, target: {kind:'container', containerId, cmd?} | {kind:'nodeShell', cmd?} }`. Runs the **full policy gate** (RBAC via membership role + `TerminalPolicy.allowedRoles`; node-online via `requireOnlineNode`; container-exists via `ctx.hub.latestContainers(nodeId)`; MFA freshness; approval lookup for node shell), creates a `TerminalSession` row, writes `AuditLog`, mints a ticket, returns `{ sessionId, ticket, wsUrl }`. **This is the one place RBAC/MFA/approval is enforced** — `/term/ws` only validates the ticket.
- `terminal.list` / `terminal.get` — live + historical sessions for the org (admins see all; members see own). Feeds an "active terminals" admin panel.
- `terminal.close` — `mutation`, admin or owner can kill *any* session (sends `ptyClose` to the agent + closes the browser WS); a user can close their own.
- `terminal.policy.get` / `terminal.policy.set` — `adminProcedure`; toggles for the org.
- `terminal.approval.request` / `.list` / `.decide` — node-shell break-glass.
- `terminal.recording.get` — returns asciicast for replay (RBAC: admins/owner, or the actor).
- Procedures: container exec ⇒ a new `execProcedure = orgProcedure.use(rbac+mfa)`; node shell ⇒ `nodeShellProcedure` (stricter: admin/owner + approval). Build these as middlewares layered on `orgProcedure`, matching the existing `adminProcedure` pattern.

### UI surfaces (`apps/app`, components in `packages/ui`)

- `packages/ui`: a `<Terminal>` (xterm.js wrapper: fit addon, webgl, the ~30-line WS attach binding, reconnect, a status bar with "● recording", session duration, "terminate") and an `<AsciinemaPlayer>` for replay.
- Dashboard routes (TanStack Router):
  - Container detail → **"Exec"** tab: a shell picker (sh/bash/custom) + `<Terminal>`. Default action is literally one button: **"Open shell"**.
  - Node detail → **"Shell"** tab: present only if `TerminalPolicy.nodeShellEnabled` *and* the agent reports node-shell capability; otherwise a clear "Node shell is disabled (set SWARMY_ALLOW_NODE_SHELL / enable in org policy)" state. Break-glass: a "Request access" button when approval is required.
  - **Security → Terminal** settings page (policy toggles, active sessions with live kill, audit/recording history with inline replay).
- Client flow: call `terminal.open` → get `{sessionId, ticket}` → open `new WebSocket('/term/ws?ticket=…')` → pipe to `<Terminal>`.

## MVP vs later

**MVP (ship the 90% case, securely):**
1. New `terminal.ts` protocol messages + union wiring + constants; `SessionId`.
2. Agent: container exec PTY via dockerode (`execInteractive`, shell probe), gated by existing `SWARMY_ALLOW_EXEC`. Un-stub `execCommand` non-interactive path as a side benefit.
3. Controller `TerminalHub` + `/term/ws` + ticketing; extend `gateway/protocol-handlers.ts` to route pty frames.
4. tRPC `terminal.open/close/list`, `TerminalSession` + `TerminalPolicy` models, `AuditLog` writes.
5. xterm.js Exec tab on container detail. Idle timeout + max-output kill. **Mandatory recording for the session record (bytes counts) ; full asciicast recording on by default.**
6. RBAC: only owner/admin by default (`allowedRoles`); MFA-fresh check if Better Auth MFA is enabled.

**Phase 2 (node shell + harder controls):**
7. Node shell via `node-pty`, gated by new `SWARMY_ALLOW_NODE_SHELL` **and** org `nodeShellEnabled`, recording **non-disableable**.
8. Approval / four-eyes break-glass flow (`TerminalApproval`), MFA-required, time-boxed grants.
9. Asciinema replay in dashboard + downloadable recordings; "active terminals" admin kill panel; per-session output-rate backpressure/flow-control message.

**Phase 3 (power users / enterprise):**
10. `swarmy ssh <node>` / `swarmy exec <svc>` CLI bridging the same PTY protocol to a local terminal (ProxyCommand-friendly) — the "real SSH client" without sshd on nodes.
11. Command allow/deny policy & redaction (regex-mask secrets in recordings), clipboard/file-transfer (`upload`/`download` over the same session), collaborative read-only "watch this session" links.
12. Per-target service exec ("exec into *the* container of service X, wherever it's scheduled") resolving task→node→containerId via swarm task inspection.

## Dependencies

- **No hard dependency on other epics.** Cleanly additive: new protocol messages, new WS endpoint, new models, new router.
- **Soft dependency on Volumes/DR object store** for the recording sink (asciicast blobs). Until that lands, write recordings to a local controller path or Postgres for small sessions; the `recordingRef` indirection makes the swap a one-liner.
- **Soft dependency on Better Auth MFA** being enabled for the `requireMfa` gate to be meaningful; if MFA isn't configured, the gate degrades to "session-fresh within N minutes" + audit, and the UI says so.
- **Agent image** must include `node-pty` prebuilt for the target arch (Phase 2 only). MVP (container exec) needs nothing beyond dockerode, already present.
- Frontend deps: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `asciinema-player` (Phase 2 replay).

## Risks & open questions

- **This is the primary RCE path.** A controller compromise ⇒ shell on every node. Mitigations beyond the gates above: keep node shell **off by default** (separate env flag + org toggle), mandatory recording, mandatory MFA + approval for node shell, per-session audit, idle/max-session caps, and consider an **agent-side independent confirmation** for node shell (the agent could require a node-local touch-file / one-time code on first node-shell open, so a controller alone can't silently root a box). Open question: do we ship that agent-side second factor in v1 of Phase 2, or document it as enterprise?
- **`node-pty` native build** across arches (arm64/amd64, musl/glibc) is a packaging chore and the classic source of agent build pain. Mitigation: vendor prebuilds; have a `Bun.spawn`-based degraded fallback (no full job control) so the agent never fails to build.
- **Bun single `websocket` handler per `serve`.** Two WS endpoints (`/agent/ws`, `/term/ws`) share one Bun `websocket` config. Resolved by discriminating on `ws.data` inside the handlers; verify there's no cross-talk and that `maxPayload` (1 MiB) suits both. Open question: split into two `Bun.serve` ports if it gets messy (terminal on its own port behind the same reverse proxy).
- **Recording of secrets.** Shells echo passwords, tokens, `env`. Recordings are sensitive data. Encrypt at rest, scope read access tightly (owner/admin/actor), set retention, and add regex redaction in Phase 3. Call out in docs.
- **Ticket vs cookie auth on WS.** Cookies on WS upgrade are inconsistent across proxies; the single-use ticket is the robust path and also the CSRF defense. Confirm the reverse-proxy passes the upgrade and the ticket query param isn't logged (use a header if the proxy logs query strings).
- **`Tty:true` stdout/stderr merge** means the non-tty exec case needs demuxing — handle both paths in the agent to avoid corrupted output.
- **Idle vs long-running commands.** Idle timeout must key off *I/O activity*, not wall-clock, so a `tail -f` or a long build doesn't get killed; `maxSessionMs` is the hard cap. Surface both in the UI.

## Simplicity note

For the user it stays one click. On the container page, **"Open shell"** does everything: tRPC `terminal.open` runs policy, mints a ticket, the browser opens `/term/ws`, xterm.js attaches — they're at a `#` prompt in well under a second, behind NAT, with nothing exposed and no SSH keys to manage. Container exec is **on by the existing `SWARMY_ALLOW_EXEC` flag** they already know; no new config for the common case. Node shell — the genuinely dangerous one — is **off until explicitly turned on twice** (agent env flag + org policy), which is the correct default and itself a feature ("swarmy can't shell your hosts unless you let it"). Recording, audit, idle limits, and RBAC are automatic and invisible until needed. Zero new infrastructure: no bastion, no sshd, no VPN, no extra port — it rides the WebSocket the agent is already holding open.
