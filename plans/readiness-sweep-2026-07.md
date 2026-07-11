# Readiness sweep: test every feature against a live (non-demo) backend

**Goal:** systematically exercise swarmy end-to-end on real infrastructure (two Lima VMs,
NetBird mesh, a live Docker Swarm, a real Postgres-backed API — no demo/mock mode), fix what's
broken where feasible, and document what isn't in `issues/`.

**Environment:** `swarmy-node-1` (manager) + `swarmy-node-2` (worker), both Lima VMs, mesh-joined
via NetBird, enrolled to org `Calum MacRae's team` (`orgId` starts `hRQ9kThFFZIy...`) through the
dashboard's real "Add a node" install-script flow — not `scripts/mint-token.ts` (hardcoded to the
old `swarmy-dev` org) and not seeded/demo data.

## Status

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Node onboarding + mesh connectivity | ✅ Done | Both nodes enrolled, `Ready` in swarm, direct NetBird ping confirmed (33-36ms). Found + fixed [[node-rejoin-wrong-org]] along the way. |
| 2 | WordPress blueprint deploy (stacks/deploy pipeline) | 🔴 **Blocked** | See below. |
| 3 | Issue documentation | ✅ Done (ongoing) | 5 issues written so far in `issues/`. |
| 4 | This plan | ✅ Done | |
| 5 | Remaining feature sweep (backups-dr, CI/CD+registry, managed-data-services, observability/OTEL, geo-edge-routing/DNS, auth/ABAC, REST API surface, node recovery, ingress, terminal/web-SSH, licensing) | ⏸️ Paused | Blocked by #2 — most of these involve deploying a stack, which needs a working overlay network. |
| 6 | Scratch file cleanup | ⏳ Pending | `apps/api/diag-org.ts`, `apps/api/scratch-check-mesh.ts` still present, untracked. |

## Current blocker: Docker Swarm overlay networking is broken on both nodes

**This stops all further stack-deploy testing** and needs a decision before continuing.

### What happened

Earlier in this sweep, `swarmy-agent rejoin --force` on node-1 (recommended by the agent's own
`doctor` command, to move swarm traffic off a stale LAN IP onto the mesh IP) hung and left the
node in a broken swarm state (`ControlAvailable: false`). With explicit authorization, this was
recovered via `systemctl restart docker` + a `rejoin --force` retry, which succeeded, and node-2
was manually rejoined. Both nodes then showed `Ready` in `docker node ls`, mesh connectivity was
confirmed, and Task #1 above was marked done.

**That recovery was incomplete.** Investigating why the WordPress blueprint deploy failed
(`(HTTP code 500) server error - no VNI provided` — see reproduction below) found that:

- `docker info` on **both** nodes still shows the identical *stale* manager address
  (`100.71.150.60:2377` — a mesh IP NetBird reassigned away from node-1 days ago) in
  `RemoteManagers`, including on node-2, which explicitly joined against the *correct* address.
  This points at the manager's own raft-carried node record surviving the `--force-new-cluster`
  reform with the old address baked in, and every node inheriting it via gossip regardless of
  what address they actually dialed.
- Docker's overlay-network control plane (VXLAN ID allocation — separate from the Raft/gRPC
  control API that `docker node ls` uses) depends on that address to form its own gossip mesh.
  With it wrong, that mesh never stabilizes: `journalctl -u docker` shows `"initialized VXLAN UDP
  port to 4789"` repeating every ~5-10 seconds indefinitely on both nodes, instead of once at
  startup — a continuous crash-loop, not a transient hiccup.
- **Every new overlay network fails to create**, confirmed with a fresh, previously-unused name
  (`zztest-net`) and after removing all leftover orphaned networks from earlier org tests
  (`blog-net`, `gpgog_db-net`) — ruling out a name/VNI-specific conflict.

Full writeup: [[rejoin-force-can-corrupt-manager]] (updated 2026-07-10 with this finding).

### Reproduction

1. Dashboard → Deploy → Blueprints → WordPress → name `wptest`, size S, no domain → Deploy.
2. Secret `wptest-db-password` is created successfully.
3. Stack deploy step fails: `(HTTP code 500) server error - no VNI provided`.
4. Confirmed independently via `docker network create --driver overlay --attachable zztest-net`
   on node-1 directly — same error, no swarmy involved.

### Why this needs a decision rather than another silent fix

The realistic fix is a **full swarm teardown and clean rebuild** — `docker swarm leave --force`
on both nodes, then a fresh `docker swarm init --advertise-addr <node-1 mesh IP>` (not
`--force-new-cluster`, which is what got us into this state) followed by a normal `docker swarm
join` from node-2. That's the same class of irreversible local-destruction action already
authorized once this session. It's low-risk right now (0 real services/data on either node — only
test secrets and an aborted `wptest` deploy), but it needs the same explicit go-ahead, since it's
a repeat of a destructive recovery action, not a routine fix.

**Not proposing this as a swarmy code fix** — this is Docker Engine's own overlay-network gossip
state, not something swarmy's installer/agent code caused or can repair from the outside. The
underlying swarmy code bug this traces back to is `apps/agent/src/cli/rejoin.ts`'s
`forceManagerReform()` using `--force-new-cluster`, which Docker itself documents as a
last-resort that doesn't guarantee full object integrity afterward (see suggested fix in
[[rejoin-force-can-corrupt-manager]] — add a bounded timeout/stale-peer detection there so this
situation is avoided rather than needing recovery).

### Options going forward

1. **Rebuild the swarm from scratch** (recommended) — clean `leave --force` + `init` on both
   nodes, re-enroll is not needed (swarmy-level node identity is separate from Docker swarm
   membership, confirmed by node-2's `reconnect` correctly reusing its existing swarmy node ID
   through the earlier recovery). Unblocks all remaining stack-deploy testing.
2. **Provision fresh VMs** instead of repairing these — slower, but guarantees no leftover state
   from this session's multiple recovery attempts and earlier org-switch testing.
3. **Pause the stack-deploy portion of this sweep** and finish auditing the non-deploy-dependent
   surfaces first (auth/ABAC, REST API surface docs, licensing, UI-only flows), coming back to
   deploy testing once a decision is made.

Waiting on the user's call before taking any of these — all three are reasonable, but #1 and #2
both involve destructive actions on the test VMs.
