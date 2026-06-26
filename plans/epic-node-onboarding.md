# Epic Plan: One-command live node onboarding (install script)

## Problem

A new user has a fresh Linux box and a swarmy account. To go from "empty VPS" to "node showing ONLINE in the dashboard" they currently must: install Docker, build/ship the agent binary, set `SWARMY_JOIN_TOKEN` + `AGENT_WS_URL` env vars, run it under a supervisor, and (for the first node) `docker swarm init` manually. That is at least six manual steps and the `settings.tsx` "Enroll a node" card today only tells them to "run the agent with `SWARMY_JOIN_TOKEN`" — there is no artifact that *does* it.

The killer-simple promise is: copy one line from the UI, paste into the box's shell, and the node appears live — including detecting/installing Docker, installing the agent as a managed service, initializing or joining the Swarm, registering over the existing handshake, and applying node labels. It must be idempotent (safe to re-run), versioned/pinned/checksummed (so `curl | bash` is auditable and reproducible), uninstallable, and it must not require the user to think about manager-vs-worker. And it has to mitigate the well-known `curl | bash` trust problem without making the happy path harder.

The hard constraints from swarmy's architecture: the controller never touches the node's Docker socket — the **agent** does and dials out. So the install script's only network dependency at runtime is (a) downloading the agent and (b) the agent's outbound WSS. Swarm `init`/`join` happen **locally on the box** via the agent/script against the local Docker socket, never controller-initiated against a remote socket.

## Recommended approach

**A single POSIX `sh` install script, served by the controller, parameterized entirely by an opaque bootstrap token in the URL path, that installs a pinned agent and runs it as a systemd service.** Concretely:

```
curl -fsSL https://app.swarmy.dev/i/<bootstrap-token> | sh
```

Tech choices and why:

- **POSIX `sh`, not bash.** Alpine/minimal images ship `busybox sh`, not bash; `#!/bin/sh` + shellcheck-clean (`-s sh`) maximizes OS coverage. We never need bash-isms.
- **Token in the URL path, not a flag.** The token *is* the unattended config. The controller resolves it server-side to: org, controller WSS URL, desired labels, role hint, agent version to pin, and the agent download URL+checksum. This keeps the pasted command to one line with no `--flags` to mistype, and means the **script body is identical for every user** — only the URL differs — so the body itself can be a static, cacheable, signed artifact. The token is the *join token already in the DB* (the `swt_<prefix>_<secret>` from `token.service.ts`), reused as the bootstrap credential. No new secret type.
- **Two-stage fetch (thin loader → pinned installer).** `GET /i/:token` returns a tiny loader whose only job is to print the pinned version + checksums and then fetch the real installer. The installer and the agent tarball are content-addressed and checksum-verified. This is what makes `curl | bash` honest: the thing you pipe to your shell is small and reviewable, and everything it downloads afterward is checksum-pinned so a later CDN/registry compromise can't silently swap the agent. (See Security.)
- **systemd as the supervisor, with a Docker-container fallback.** systemd is on essentially every non-EOL server Linux (Ubuntu/Debian/RHEL/Alma/Rocky/Fedora/Amazon Linux 2023/SUSE). It gives us restart-on-crash, boot persistence, journald logs, and a clean `systemctl disable --now` uninstall — for free, no daemon code. For systemd-less hosts (Alpine/OpenRC, or "I'm inside a container") we fall back to running the agent **as a Docker container** (`swarmy/agent` with the socket bind-mounted + `--restart unless-stopped`). One detection branch, two install backends, same agent.
- **Agent shipped as a single self-contained executable** built with `bun build --compile` (the agent is already a Bun app). No Node/Bun runtime to install on the node, no npm. One file per `os/arch` (`linux-x64`, `linux-arm64`), checksummed. This is dramatically simpler than asking users to have a runtime, and `--compile` is already the natural packaging for a Bun app.

**Alternatives weighed:**

- *Ship the agent only as a Docker container (no native binary).* Tempting because Docker is required anyway. Rejected as the *primary* path because of a bootstrap ordering problem: on a box with no Docker, the script must install Docker before it can run the agent, and we'd also be coupling agent lifecycle to the very Docker daemon it manages (a Docker restart kills the agent that's mid-deploy). systemd-native binary decouples the two. We keep the container as the documented fallback, not the default.
- *Bash with rich flag parsing (`--token --url --role --labels`).* Rejected: more surface to mistype, more to document, and it pushes config to the client when the controller already knows everything. The token-resolves-to-config model is strictly simpler for the user.
- *Ansible / cloud-init / k0sctl-style remote push.* Rejected for MVP: requires the controller to have SSH/credentials to nodes, which violates the dial-out, NAT-friendly, "controller never reaches into the node" principle. `curl | sh` is pull-based and works behind NAT with zero inbound ports — exactly the model the agent already uses.
- *Generic version-pinned URL (`/install.sh?token=…`).* Path-token (`/i/:token`) is cleaner to copy, avoids query-string logging surprises, and lets us 410 a revoked token at the edge.

## Architecture & integration

### How it ties into the existing register handshake (the key integration)

Nothing about the wire protocol's auth changes. The script's job ends exactly where the existing `handleRegister` (`apps/api/src/gateway/protocol-handlers.ts`) begins:

1. Script writes a config file (`/etc/swarmy/agent.env`) containing `SWARMY_JOIN_TOKEN` and `AGENT_WS_URL` (both come from the bootstrap-token resolution).
2. systemd starts the agent. The agent does exactly what `apps/agent/src/index.ts` already does: no saved state → builds `{ auth: { kind: 'join', joinToken } , facts }` and sends `register`.
3. The controller's existing `auth.kind === 'join'` branch upserts the `Node` (keyed `orgId_name` on hostname), increments `uses`, mints+rotates the per-node `sessionSecret`, returns `registerAck`.
4. Agent persists `~/.swarmy/agent.json` (mode 0600, via `saveState`) and from then on reconnects with `kind: 'session'`. **The join token is single-use-effective**: after first register the agent never needs it again, so the script can (and should) `shred`/remove it from the env file on success — see Security.

So the install script is "plumbing to the existing front door," not a new auth path.

### New: serving + resolving the script (apps/api)

Add three unauthenticated routes to the Hono app in `apps/api/src/index.ts` (they're authenticated by *possession of the bootstrap token*, like the WS join):

- `GET /i/:token` → the **loader**. Resolves token (reuse `hashToken`/`sha256` + the same validity checks as `handleRegister`: not revoked, not expired, not exhausted). On invalid → `410 Gone` with a plaintext `echo "swarmy: token invalid/expired" >&2; exit 1` body (so a piped shell fails loudly, not silently). On valid → emits a small `sh` script with these values **interpolated as the only variables**:
  - `SWARMY_TOKEN` (the raw token — but see note: the loader receives the *raw* token in the URL, so we just echo it back; the DB only stores the hash)
  - `SWARMY_WS_URL` (`env.CONTROLLER_PUBLIC_URL` → `wss://…/agent/ws`)
  - `SWARMY_AGENT_VERSION` (pinned, from a new `installConfig`)
  - `SWARMY_INSTALLER_URL` + `SWARMY_INSTALLER_SHA256`
  - per-`os/arch` `AGENT_SHA256` map
  - `SWARMY_LABELS` (from the token's configured labels), `SWARMY_ROLE_HINT`
  Then `exec`s the installer (downloads `$SWARMY_INSTALLER_URL`, verifies sha256, runs it).
- `GET /dl/installer/:version/install.sh` → the **installer** (static, version-pinned, served with long cache + immutable; this is the big script and is itself checksummed by the loader).
- `GET /dl/agent/:version/:platform` → the **agent binary** (`swarmy-agent-linux-x64`, etc.), checksummed.

For MVP the installer + binaries can be served straight from the controller's filesystem (built into the `apps/api` image / a mounted `dist/`); later they move behind a CDN/object store with the controller only minting the *loader* and signed URLs.

A small `apps/api/src/install/` module owns: token→config resolution, version pinning, and reading the checksum manifest. Reuse, don't duplicate, the token validity logic — extract the "is this join token usable" check from `protocol-handlers.ts` into a shared `token.service.ts` helper (`assertJoinTokenUsable`) and call it from both the WS register path and the `/i/:token` route.

### New: DB models

- **`InstallConfig`** (org-scoped, optional singleton like `IngressConfig`): `pinnedAgentVersion`, `defaultLabels Json`, `allowAutoSwarmInit Boolean @default(true)`. Lets an org pin a version and define default node labels applied at enroll.
- **Extend `JoinToken`** with onboarding intent (all optional, nullable): `roleHint NodeRole?` (manager/worker preference for the *first* vs subsequent nodes), `labels Json @default("{}")` (labels to apply to nodes enrolled with this token), `installVersion String?` (pin a specific agent version to this token). These flow from token-mint UI → `/i/:token` → script → node. Zero new tables for the common case.
- **Extend `Node`** with `enrollMethod String?` ("install-script" | "manual"), and `pendingLabels Json?` so labels requested at enroll can be reconciled onto the swarm node once it's online (the agent applies them via the existing `updateSwarmNode` command). `swarmManagerToken`/`swarmWorkerToken` are **not** stored centrally — see Swarm join below.

### Swarm init vs join (manager vs worker) — kept zero-config

This is the subtle part, solved without the controller ever holding a Docker socket:

- The script + agent determine swarm state from the **local** Docker (`getNodeFacts().swarmRole` already exists). Three cases:
  - **No swarm anywhere in the org yet** (controller knows: `Node` count with `swarmNodeId != null` is 0): the first node runs `docker swarm init` locally. It becomes the manager. The script learns "you are first" from the token resolution / a new lightweight controller call.
  - **Joining an existing swarm**: the new node needs the swarm's join-token (Docker's own `SWMTKN-…`, distinct from swarmy's join token) **and** the manager's advertise address. We get these **on demand from an existing online manager via a new controller→agent command** (`swarmJoinInfo`), never by storing the raw `SWMTKN` long-term. Flow: agent registers (join) → controller sees the org already has a manager → controller dispatches `getSwarmJoinInfo` to that manager agent → manager returns `{ managerAddr, workerJoinToken }` (short-TTL) → controller relays it to the new agent in the registerAck/a follow-up command → new agent runs `docker swarm join`. Worker-by-default; manager only if `roleHint=manager` (then it joins with the manager token and we cap manager count sanely).
  - **Already in a swarm**: no-op (idempotent).
- This means the *script* doesn't handle swarm tokens at all — the **agent** does, via new protocol messages. The script just installs+starts the agent; the agent + controller negotiate swarm membership. This keeps swarm secrets off disk-in-env and off the controller, and matches the "agent applies generic intent" principle.

### New protocol messages (packages/core/src/protocol/commands.ts)

Add to the `ControllerToAgentMessage` union (and matching agent→controller results via the existing `commandResult`):

- `getSwarmJoinInfo` (controller→manager-agent): `{ ...cmd, role: 'worker'|'manager' }` → result `{ managerAddr, joinToken, expiresAt }`. Agent implements via `docker.swarmInspect()` / `docker.swarm().JoinTokens` + advertise addr.
- `swarmInit` (controller→agent): `{ ...cmd, advertiseAddr?: string }` → `docker swarm init`. Result `{ swarmNodeId, managerAddr }`.
- `swarmJoin` (controller→agent): `{ ...cmd, managerAddr, joinToken }` → `docker swarm join`. Result `{ swarmNodeId }`.

These require three new methods on the `DockerClient` wrapper (`packages/core/src/docker.ts`): `swarmInit`, `swarmJoin`, `getSwarmJoinTokens` — thin dockerode passthroughs alongside the existing `updateSwarmNode`. Add the new types to the `DEFAULT_COMMAND_TIMEOUTS` table and the executor `switch`. Bump `PROTOCOL_VERSION`? **No** — these are additive command types; the discriminated-union parser ignores unknown types gracefully and older agents simply never receive new commands. Only bump if we change an existing message's shape.

Reuse the **existing** `updateAgent` command (already defined: `targetVersion`, `downloadUrl`, `sha256`, `strategy`) for in-place agent upgrades post-install — the install script and the update command share the same checksum-verified binary URL, so versioning is consistent end to end.

### New: tRPC router surface

Extend `nodesRouter` (or a new `installRouter`):
- `getInstallCommand` (orgProcedure): returns `{ command, token, expiresAt, scriptUrl }` for a given (or freshly minted) join token — this is what the dashboard's copy box renders. It does **not** re-expose old tokens (hash-only storage); it's called right after `generateJoinToken`, or it mints-on-demand.
- `installConfig.get/set` (adminProcedure): pin version, default labels.
- Extend `generateJoinToken` input with `roleHint`, `labels`, `installVersion`.

### Agent capabilities

- Handle `swarmInit` / `swarmJoin` / `getSwarmJoinInfo` in `executor.ts`.
- Honor a new `SWARMY_NODE_LABELS` / `SWARMY_NODE_NAME` env (written by the script) so node naming/labels are set at first register (passed in `facts` or applied right after via `updateSwarmNode`).
- Self-update via existing `updateAgent` (implement the currently-stubbed handler): download → verify sha256 → for `self-replace` swap the binary and `systemctl restart swarmy-agent` (systemd re-execs it); for `docker-recreate` pull new image + restart container.

### UI surfaces (apps/app)

In `settings.tsx` "Join tokens" tab and a new prominent **Nodes → "Add node"** flow:
- Replace the "run the agent with `SWARMY_JOIN_TOKEN`" copy with a **copy-paste install box**: the one-liner `curl -fsSL https://app.swarmy.dev/i/<token> | sh`, a `CopyButton` (already in `@swarmy/ui`), an OS tab strip (Linux now; "macOS/Windows via Docker Desktop" later), and an expandable "What does this do? / Review the script" disclosure linking to `/i/<token>` raw + the pinned installer + checksums (so the security-conscious can read before running).
- A **"waiting for node…" live panel** right under the box: poll `nodes.list` (already `refetchInterval: 5000` in `nodes/index.tsx`) or subscribe, and when a node whose `joinTokenId` matches this token transitions PENDING→ONLINE, show a green "node `<hostname>` connected" toast and link to it. This is the "magic" moment — the node literally appears as you watch. The `Node.joinTokenId` link already exists in the schema, so we can correlate the newly-appeared node to the token the user is looking at.
- Per-token "role" + "labels" inputs at mint time (feeds `roleHint`/`labels`).

### Idempotency / re-run

The installer is fully re-runnable:
- Detects existing `/etc/swarmy/agent.env` + running service → "already installed, reconciling" (updates version if pinned changed, restarts, exits 0).
- Detects Docker present → skips install.
- Detects existing agent state (`~/.swarmy/agent.json` or `/var/lib/swarmy/agent.json` for the system service) → the agent will reconnect via session, not re-consume a join token. Re-running the same one-line command on an *already-enrolled* node is a no-op, not a duplicate node (hostname-keyed upsert in `handleRegister` guarantees this).
- Swarm: `docker swarm init`/`join` are guarded by `getNodeFacts().swarmRole !== 'none'`.

### Rollback / uninstall

Ship `swarmy-agent uninstall` (a subcommand of the binary) and document `curl -fsSL …/i/<token>?uninstall=1 | sh`:
- `systemctl disable --now swarmy-agent`, remove unit, remove `/etc/swarmy`, `shred` the state file, remove the binary.
- Leaves Docker and the swarm **untouched by default** (we didn't necessarily install Docker; tearing down swarm is destructive) — with an opt-in `--leave-swarm` that runs `docker swarm leave`.
- The installer keeps the previous binary as `swarmy-agent.prev` so a failed self-update can roll back; the systemd unit's `Restart=on-failure` plus a healthcheck means a broken new version auto-recovers to a crash-loop we can detect, and `updateAgent` rollback restores `.prev`.

### Supported OSes (MVP)

x86_64 + arm64 Linux with systemd: Ubuntu 20.04+, Debian 11+, RHEL/Alma/Rocky 8+, Fedora, Amazon Linux 2023, SUSE/openSUSE. Docker install uses the official `get.docker.com` convenience script when a distro package isn't already present (well-trodden, multi-distro), gated behind a detection + a "swarmy will install Docker via get.docker.com, continue?" line that's auto-yes in the piped/non-interactive case but logged. Alpine/OpenRC and "no systemd" → container-fallback backend. macOS/Windows: documented as "run the agent container under Docker Desktop," not the native script (later).

## MVP vs later

**MVP (ship the killer demo):**
1. `bun build --compile` agent binaries for `linux-x64`/`linux-arm64` + checksum manifest, served from the controller.
2. `/i/:token` loader + `/dl/...` installer & binary routes; token→config resolution reusing existing join-token validation.
3. POSIX installer: detect/install Docker (get.docker.com), detect arch, download+verify agent, write `/etc/swarmy/agent.env`, install+start systemd unit. Idempotent re-run. Uninstall path.
4. Swarm: **first-node `docker swarm init` only** (single-manager case). Multi-node join can be MVP-light: worker join via `getSwarmJoinInfo`→`swarmJoin` if a manager is online; otherwise the node still registers and runs standalone (swarmy works "with or without swarm").
5. Dashboard: copy-paste box in Settings + a live "node connected" indicator correlated by `joinTokenId`.
6. Security baseline: 2-stage fetch, sha256 pinning of installer+binary, token in path, loud failure, post-enroll token scrub from env file.

**Later:**
- Container-fallback backend (OpenRC/no-systemd) and macOS/Windows docs.
- Full manager-quorum-aware join (promote/demote, odd manager count) + `swarmInit` advertise-addr selection on multi-NIC hosts.
- Cosign/minisign **signatures** on the installer + binaries (not just sha256), and an SLSA-style provenance/`/install.txt` page.
- CDN/object-store for binaries with controller-minted short-TTL signed URLs; per-org private mirror for enterprise.
- `installConfig` version pinning + staged `updateAgent` rollouts across the fleet from the UI.
- Windows/macOS native agents; `apt`/`yum` repo + `.deb`/`.rpm` for users who'd rather not pipe to shell.
- Mesh-client install (the networking epic) slotted into the same installer as one more verified download + systemd unit.

## Dependencies

- **Networking epic (mesh client):** the script must also install the mesh client. Coordinate so the installer treats mesh as a second checksummed artifact + unit driven by the same token resolution. Design the installer's "download+verify+install-unit" step as a loop over an artifact list so adding mesh is data, not new code.
- **Release/build infra:** a CI job that `bun build --compile`s per-platform binaries, generates the checksum manifest, and (later) signs them. This is the single biggest new infra piece. Until it exists, MVP can build locally and bake into the `apps/api` image.
- **Existing protocol/gateway:** depends on extracting `assertJoinTokenUsable` from `protocol-handlers.ts` and adding the three swarm command types to `core` + executor. Coordinate the protocol additions with anyone else touching `commands.ts`.
- **`CONTROLLER_PUBLIC_URL` / public reachability:** the agent's WSS URL must be publicly resolvable + TLS-terminated for real nodes; the script derives it from `env.CONTROLLER_PUBLIC_URL`. Hosted cloud provides this; self-hosters must set it (validate at mint time and warn if it's `localhost`).

## Risks & open questions

- **`curl | sh` trust.** Inherent. Mitigated (below) but never eliminated; some orgs forbid it — that's why `.deb`/`.rpm` + "review the script" + signatures are on the roadmap, and why the piped artifact is deliberately tiny.
- **Docker install via get.docker.com** runs *their* `curl | sh` transitively. We pin nothing there. Mitigation: prefer the distro's own Docker if present; document; later replace with distro-native package installs we control.
- **Swarm advertise-address ambiguity** on multi-NIC / cloud hosts (private vs public IP, NAT). `docker swarm init` may pick the wrong interface. Open question: auto-detect vs require an addr hint in the token. MVP: let Docker auto-pick for single-NIC; surface a clear error + retry-with-addr for multi-NIC.
- **Manager join secrets transit.** Worker/manager `SWMTKN` flow controller→agent over the (TLS) WS. Acceptable (same channel as all commands) but we keep them short-TTL and never persist the manager token. Confirm Docker rotates these on demand.
- **Hostname collisions** (cloud images with identical default hostnames → `orgId_name` upsert merges two real nodes into one). Mitigation: include a stable machine-id in the node name/facts when hostname is generic; open question whether to key on machine-id instead of hostname.
- **Re-run consuming a fresh join-token use** when state is missing but agent re-registers: ensure the script, on detecting an existing system install, does *not* rewrite the env with a fresh token. Open question: should single-use tokens auto-expire-on-success server-side (set `maxUses=1` effectively the moment a node session is established)?
- **Binary size / cold download** of `bun --compile` outputs (tens of MB). Fine over good links; consider compression + CDN for slow regions.
- **Idle-timeout / first-boot races:** Docker just-installed may not have a running daemon when the agent starts; the systemd unit needs `After=docker.service` (or a wait-for-socket loop) — the agent already degrades gracefully (`docker unavailable` branch) but swarm init must wait for the daemon.

## Simplicity note

The user does exactly one thing: copy one line from the dashboard and paste it into their server. No flags, no env vars, no version numbers, no manager-vs-worker decision, no `docker swarm init`, no editing config files. The token in the URL carries every decision, resolved server-side, so the command is identical to read and impossible to misconfigure. Re-running it is always safe. Docker, the agent, the supervisor, and swarm membership are all handled for them, and the node appears live in the UI within seconds — they *watch it connect*. The security-minded can click "review the script" before running; everyone else just pastes. That is the whole feature: copy, paste, done.

---

Key existing files this epic plugs into (all absolute): `/home/user/swarmy/apps/api/src/index.ts` (add `/i/:token` + `/dl/*` routes), `/home/user/swarmy/apps/api/src/gateway/protocol-handlers.ts` (extract `assertJoinTokenUsable`; already the register front door), `/home/user/swarmy/packages/trpc/src/services/token.service.ts` (`hashToken`, `generateJoinToken` — extend with role/labels), `/home/user/swarmy/packages/trpc/src/routers/nodes.ts` (add `getInstallCommand`, `installConfig`), `/home/user/swarmy/packages/core/src/protocol/commands.ts` (add `swarmInit`/`swarmJoin`/`getSwarmJoinInfo`; reuse `updateAgent`), `/home/user/swarmy/packages/core/src/protocol/constants.ts` (`DEFAULT_COMMAND_TIMEOUTS`), `/home/user/swarmy/packages/core/src/docker.ts` (add `swarmInit`/`swarmJoin`/`getSwarmJoinTokens`), `/home/user/swarmy/apps/agent/src/executor.ts` + `/home/user/swarmy/apps/agent/src/env.ts` + `state.ts` (handle new commands, system state path, self-update), `/home/user/swarmy/packages/db/prisma/schema.prisma` (`InstallConfig`, extend `JoinToken`/`Node`), `/home/user/swarmy/apps/app/src/routes/_authed/settings.tsx` + `/home/user/swarmy/apps/app/src/routes/_authed/nodes/index.tsx` (copy-paste box + live "node connected" panel).
