# Node recovery — "a node that goes dark always comes home"

## The feeling we are building

Onboarding is one line and it feels like magic (see
[`compute-and-onboarding.md`](./compute-and-onboarding.md)). Recovery has to
feel the same. The moment a node stops checking in, the person running swarmy
should never be spelunking through systemd, hand-editing token files, or
guessing which `docker swarm` incantation is safe. They should have exactly two
moves, and both should be obvious:

1. **From the dashboard** — the offline node grows a **Repair this node**
   button. Copy the line, paste it on the box, done.
2. **On the box** — one command, `swarmy-agent doctor`, tells them what is
   wrong in plain words, and `--fix` does the safe repairs.

Everything below exists so that those two moves cover the whole space of "my
node won't come back," including the cases where the box has lost every
credential it ever had, and the case where the controller itself is
unreachable and there's data on the node you can't afford to lose.

The north star: **re-running the same onboarding one-liner is always safe and
always heals.** Not a different "recovery command" — the *same* line. A tool
you reach for in a calm moment is a tool you can find in a panic.

## Why this needed building

The dial-out model already makes nodes resilient to the controller being down
(the agent just retries). What it did *not* handle was the node losing its own
identity. A node authenticates with a join token once, then with a rotating
session secret. Two real failures fell through:

- **A reboot could strand a node.** The session secret is the durable
  credential, but it was written to disk fire-and-forget. If that write never
  landed and the box rebooted, the agent fell back to the join token in its env
  file — and because mesh-enabled tokens are single-use, that token was already
  consumed. The node was permanently offline with no operator-visible path
  back. (This actually happened; see the mesh-first e2e run.)
- **There was no floor.** If both the session AND the token were gone or
  rejected, nothing recovered the node short of a full re-install — which
  destroys its identity and its place in the swarm.

Recovery closes both, and adds an on-box operator surface (the CLI/TUI) so the
answer to "why won't this node connect?" lives *on the node*, not only in the
dashboard the node can't reach.

## How it works (the recovery ladder)

Recovery is a ladder from "heals itself, invisibly" up to "one human click,"
never skipping a rung, never doing something destructive without a typed
confirmation.

### Rung 0 — durable session, so reboots just work

The session credential is now written with retry and read-back verification
before the agent trusts it, and a failed write is loud in the journal instead
of silent. A node that has registered once survives a reboot on its own.

### Rung 1 — re-adoption, so "paste it again" heals

The controller **re-adopts a node by hostname**. A join token that has been
consumed (or even expired) stays valid *for the one node it originally
enrolled*. Re-presenting it from that same box re-authenticates it and hands
back a fresh session — it can never enroll a *new* node, so "single-use" still
means single-use for the thing that matters (a leaked one-liner can't spawn
nodes). This is what makes the env-file token a durable fallback credential,
and what makes re-running the one-liner safe: same hostname → same node, no
duplicate, identity preserved. Revoking the token in the dashboard is still the
absolute kill switch and overrides re-adoption.

### Rung 2 — the self-healing one-liner

Re-running "Add a node" on an already-enrolled box detects the existing install
and switches to **repair mode**: refresh the binary to the controller's current
version, refresh credentials (salvaging anything not re-supplied from the
existing env file), restart, and run the doctor's fix ladder. The dashboard
surfaces this as **Repair this node** on any offline node.

### Rung 3 — the on-box doctor

`swarmy-agent doctor` runs an ordered health ladder that mirrors how a node
comes up — binary → daemon → docker → controller → session → mesh → swarm →
workloads → disk — and each failing rung explains itself and, where safe,
offers a fix. It works whether or not the daemon is alive (that's exactly when
you need it), and whether or not the controller is reachable.

### Rung 4 — the recovery beacon (device-pairing for nodes)

When a node has lost *everything* — session gone, token rejected — it enters
recovery mode: it prints a short **fingerprint** in its journal and posts an
unauthenticated claim to the controller. A banner appears in the dashboard:
*"a machine is asking to reconnect as `web-3` — fingerprint `A1B2-C3D4`."* The
operator compares that fingerprint with what the machine printed and approves.
The node receives a fresh session credential, once, and reconnects as its old
self.

This is deliberately the **SSH host-key trust model**: the claim itself is
unauthenticated (anyone can post one), so the security is the human comparing
two fingerprints — plus hard rails: claims only ever attach to an *existing*
node (recovery can never enroll), they expire in fifteen minutes, the
credential is delivered exactly once and wiped, and delivery is bound to the
secret only the claiming machine holds.

## Rescue backups (when the controller is dark)

The normal backup path is controller-driven and never puts repo credentials on
node disk. But a node that's cut off can't use it — and that node may hold data
you need. So the agent CLI can move data with the controller completely dark:

- **Local export/restore** — tar a stack's named volumes plus a manifest to a
  file (a USB stick, another disk). Zero credentials, any volume driver. Restore
  the same file on this box or a replacement.
- **Direct push** — straight to a restic repo with *your* credentials, supplied
  by env or prompt, never on the command line. It reuses the exact restic
  sidecar machinery the controller-driven backups use.

Volume discovery is pure Docker labels, so it works offline; data always moves
through short-lived sidecar containers with the volumes bind-mounted.

## The CLI/TUI as the operator surface

The agent binary is both the daemon and a full operator CLI (`status`,
`doctor`, `reconnect`, `rejoin`, `mesh`, `backup`, `logs`, `support-bundle`,
`update`, `reset`). Run it on a terminal with no arguments and it opens a live
TUI — a diagnostics dashboard that runs *on the node*, so the node that can't
reach the controller can still tell you why.

Actions are tiered by blast radius: **green** fixes apply automatically,
**yellow** ones prompt, and **red** ones (leave the swarm, force-new-cluster,
factory reset, overwrite-on-restore) require typing a confirmation phrase and
can never be `--yes`-ed. The tool will do the safe thing for you and make you
say the dangerous thing out loud.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Node reboots | Session credential was persisted durably (retry + read-back); the agent reconnects with it, no operator action. |
| Session file lost, join token still on the box | Controller re-adopts by hostname; the env-file token re-authenticates the same node. A plain restart heals it. |
| Node won't reconnect, machine is up | **Repair this node** in the dashboard, or `swarmy-agent doctor --fix` on the box. |
| Every credential gone (session + token) | Recovery beacon: the node prints a fingerprint and posts a claim; the operator approves it in the dashboard after matching the fingerprint. |
| Swarm traffic on the wrong address (joined pre-mesh) | `swarmy-agent rejoin --force` re-forms membership on the mesh IP (red-tier confirm). |
| Controller down, data at risk on the node | `swarmy-agent backup export`/`push` works with zero controller contact. |
| Agent crashes overnight | systemd `OnFailure=` writes a full doctor report to `last-failure.json` — a post-mortem survives journald rotation. |

## Explicitly rejected

- **A separate "recovery command."** The repair path is the *same* one-liner as
  onboarding. A second command is a second thing to find under stress.
- **Auto-approving recovery claims.** The claim is unauthenticated by design; a
  human comparing fingerprints is the security boundary, exactly like SSH host
  keys. No claim is ever trusted without a person.
- **Letting recovery enroll a node.** Claims only ever re-authenticate an
  *existing* node. Recovery restores identity; it never mints it.
- **Bypassing revocation.** Re-adoption and the beacon both stop dead at a
  revoked token / removed node. Revocation is the operator's kill switch and
  nothing routes around it.
- **Caching backup credentials on nodes by default.** Rescue push uses the
  operator's own credentials, supplied at the moment of use. (A future opt-in
  for pre-positioned credentials is a deliberate, off-by-default fast-follow.)
- **Controller-initiated repair (SSH/push).** Same reason as onboarding: the
  controller never reaches into a node. Recovery is pull-based and NAT-friendly,
  driven from the box.

## Implementation map

Operational conventions and invariants live in the **`node-recovery`** skill
(`.claude/skills/node-recovery/SKILL.md`) — the on-box CLI/TUI, the doctor
ladder, re-adoption, the beacon, and rescue backups. The operator-facing
runbook is [`docs/NODE-RECOVERY.md`](../NODE-RECOVERY.md). This recovery story
builds directly on the agent dial-out model in
[`compute-and-onboarding.md`](./compute-and-onboarding.md) (skill:
`agent-handlers`) and reuses the restic machinery from
[`resilience-and-dr.md`](./resilience-and-dr.md) (skill: `backups-dr`).

Key homes: `apps/agent/src/main.ts` (CLI dispatch — the binary entrypoint),
`apps/agent/src/daemon.ts` (the daemon + recovery beacon + session
persistence), `apps/agent/src/cli/*` (`checks.ts` doctor ladder, `tui.ts`
OpenTUI dashboard, `backup.ts` rescue, `rejoin.ts`/`reset.ts` red-tier flows,
`local-socket.ts` CLI↔daemon channel), `apps/api/src/gateway/join-auth.ts`
(the `decideJoinAuth` re-adoption decision),
`packages/trpc/src/services/recovery.service.ts` (the claim state machine),
`apps/api/src/install/installer.ts` (repair mode), and the `apps/app` node
detail / nodes-index cards.
