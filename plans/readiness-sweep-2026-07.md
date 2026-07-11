# Readiness sweep: test every feature against a live (non-demo) backend

**Goal (updated 2026-07-11 per the user's `/goal` directive):** determine whether swarmy can
actually be *deployed* by a real user — through the dashboard UI, the literal one-line install
command, and the deploy/blueprint flow only. No code changes, no env-var tweaks, no SSH/manual
fixes to make a test pass: any of those is itself a FAIL to document, not a valid path to green.
Start small (ingress + a browser-reachable app locally), then scale to DigitalOcean droplets across
regions to test global DNS/geo-routing for real. Stop and write up precisely where/why whenever
genuinely blocked.

**Environment:** `swarmy-node-1` (manager) + `swarmy-node-2` (worker), both Lima VMs, mesh-joined
via NetBird, enrolled to org `Calum MacRae's team` (`orgId` starts `hRQ9kThFFZIy...`) through the
dashboard's real "Add a node" install-script flow — not `scripts/mint-token.ts` (hardcoded to the
old `swarmy-dev` org) and not seeded/demo data.

## Methodology correction (2026-07-11)

The first pass of this sweep (rows 1-2 below, done in an earlier segment) used manual SSH recovery
(`rejoin --force`, hand-editing swarm state, manual `docker swarm join`) to get nodes healthy after
hitting bugs. That is a testing-methodology mistake, not a success — see
[[manual-recovery-required-not-magical]]. **From this point on, testing goes through the product
surface only** (dashboard UI, the literal one-line install command, the deploy UI). If a step needs
SSH to fix (not just to read logs), that surface fails, gets written up immediately, and testing
does not route around it by hand.

Acting on that correction, the polluted two-node environment was torn down and a **fresh** Lima VM
was provisioned, enrolled using nothing but the exact command the dashboard's "Add a node" flow
generates (obtained by actually driving that UI, not hand-constructed). Result: **it fails at the
very first step, for every fresh node, unconditionally.** See row 1 below — this reverses the
earlier "✅ Done" status, which was only true because it was reached by hand-fixing, not because the
real flow works.

## Status

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Node onboarding via the real dashboard one-liner | ✅ **Fixed and verified (2026-07-11)** | Was blocked 100% of the time by a GHCR `denied` pull. User explicitly authorized the one-line fix documented in [[install-defaults-to-unpullable-ghcr-image]] (repoint the dashboard one-liner from `/install.sh` to the already-live, already-tested `/install/loader.sh`). Verified on a fresh Lima VM through the real, unmodified-except-for-that-one-line dashboard flow: Docker installs, systemd backend auto-selected, agent installs/starts/registers, mesh joins. No manual SSH steps needed for this stage. |
| 2 | New nodes reach a working swarm | ✅ **Confirmed working for a clean org (2026-07-11)** | Root cause: this org's `swarm_config` DB row pointed at a dead manager address from an earlier, since-destroyed test VM — every new node silently tried to "join" it instead of falling back to `init`. Fully root-caused in [[stale-swarm-config-blocks-new-nodes-after-manager-loss]]. **Retested against a genuinely fresh org** ("Sweep Tester's team", created via the real signup flow — no in-app multi-org support exists, so a new account was the only product-surface path to an unpolluted org) on a fresh Lima VM: the real, unmodified dashboard one-liner reached a healthy single-manager swarm with zero manual intervention. Confirms the bug is stale-manager-pollution-specific, not a defect in the init path itself — **the bug itself is still open and unfixed** (a real production risk for any org that permanently loses its manager), but testing continues under this fresh org since it's clean. |
| 3 | Static-site blueprint deploy (stacks/deploy pipeline) | ✅ **Works** | Deployed via the real Deploy → Blueprints flow to the fresh org's healthy 1-node swarm: converged cleanly, 1/1 replicas, zero manual intervention. The deploy pipeline itself is solid — see row 8 for what happened next (ingress). |
| 4 | Issue documentation | ✅ Done (ongoing) | 9 issues written so far in `issues/`. |
| 5 | This plan | ✅ Done (ongoing) | |
| 6 | Remaining feature sweep (backups-dr, CI/CD+registry, managed-data-services, observability/OTEL, geo-edge-routing/DNS, auth/ABAC, REST API surface, node recovery, terminal/web-SSH, licensing) | ⏳ Next up | Ingress (row 8) is done. Continuing the sweep feature-by-feature through the same fresh org/node, still via product surface only. |
| 7 | Scratch file cleanup | ⏳ Pending | `apps/api/diag-org.ts`, `apps/api/diag-org2.ts` still present, untracked. |
| 8 | Ingress: get one browser-reachable, secured route ("start small" milestone) | ❌ **FAIL — fully root-caused, documented** | Deployed the static-site blueprint, then drove the real Platform → Edge & ingress UI through every legitimate step (driver select, Enabled toggle, the separate "Deploy / converge controller" button, the separate "Target nodes" toggle). Result: **total unreachability** at every stage, confirmed three independent ways (direct node/Docker inspection, SSH-port-forwarded curl, an actual Chrome navigation), despite the dashboard confidently showing "1/1 SECURED" / "TLS auto" throughout. Four stacked root causes, one of them a deterministic, always-reproducible Docker Swarm placement-constraint bug (wrong node-ID namespace) that makes the "pin ingress to one node" path permanently unschedulable for every org, always. Full writeup: [[ingress-never-actually-serves-traffic]]. This is the literal milestone the governing directive named as the first thing to prove out, and it is not achievable today through the product surface alone. |

## Resolved decision: step-zero fix was authorized (2026-07-11)

The prior version of this section laid out three options for the GHCR blocker (stay blocked / ask
for one-time authorization / bypass via `local-vms.sh`) and deferred to the user rather than
deciding unilaterally. **The user chose option 2 — one-time authorization for the specific,
already-scoped fix** (repoint one URL, described above). It was applied and verified working for
that specific failure mode. See [[install-defaults-to-unpullable-ghcr-image]] for the full record.

That authorization was scoped to exactly that one change — it does not extend to the new blocker
in row #2 above. The same pattern (root-cause and document first, then ask before code-fixing) is
being followed again for that issue.

## Note on the overlay-networking blocker section below

The "Current blocker: Docker Swarm overlay networking is broken on both nodes" section further
down in this file describes the **earlier, two-node environment that was torn down** per the
methodology correction above (manual `rejoin --force` recovery, stale manager address, VXLAN
gossip failure). It's kept here for the underlying agent-code lesson it points at
([[rejoin-force-can-corrupt-manager]]'s suggested fix for `forceManagerReform()`), but it is not
the current blocker — the current blocker is row #2 in the status table, a completely different
(and earlier-in-the-flow) bug on a fresh single-node environment that never had a chance to reach
`rejoin --force` at all.

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
