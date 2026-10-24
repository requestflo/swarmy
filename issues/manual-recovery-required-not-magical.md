# Getting two local test nodes healthy required repeated manual SSH/swarm surgery — that's the failure

**Status:** Open, waiting on live re-verification. As of 2026-10, every item below is fixed or
mitigated in code, with unit tests. None has been re-run on real VMs through the product surface,
which is this issue's bar. Item 3 can only be fully cleared by a swarm rebuild. See "Audit
(2026-10)" at the end.

Original status: meta-finding, supersedes the framing of the individual bugs below.

## Why this is its own issue

The bar for swarmy is: install feels magical, one command per node, straight to deploying
stacks. No dialing into a machine afterward to fix things. No hand-editing env vars. No manual
`docker swarm` surgery. If any of that is needed, the *product* has failed, regardless of whether
the underlying cause is a "real" code bug or an edge case.

By that bar, this session's local two-node test failed multiple times over, well before ever
reaching a stack-deploy test:

1. `swarmy-agent doctor` recommended `rejoin --force` to move swarm traffic off a stale LAN IP.
   Running the *recommended, in-product* remediation command hung and left the sole manager with
   `ControlAvailable: false` — required a manual `systemctl restart docker` on the box to recover.
   See [[rejoin-force-can-corrupt-manager]].
2. The worker's own automatic rejoin, after being knocked off the reformed swarm, silently formed
   its **own separate one-node swarm** instead of rejoining — required a manual
   `docker swarm join` from the shell to fix. See [[worker-auto-rejoin-forms-standalone-swarm]].
3. The "recovered" manager never actually cleared the stale manager address that started all of
   this — it silently broke the overlay-network control plane cluster-wide (`no VNI provided` on
   any new network, on both nodes), only discovered later when a real blueprint deploy failed.
4. Test VMs chronically ran out of disk (journald growth, Docker image bloat, apt cache), causing
   confusing unrelated-looking failures (`curl: (23) Failure writing output to destination`)
   during plain installs. See [[vm-disk-chronically-full]].
5. A REPAIR-mode re-enrollment (re-running the install command against a node that already has
   an agent installed, with a new join token) silently dropped the NetBird mesh setup key from the
   written env file — the agent came up with no mesh client at all, no error, no log line about it
   even being attempted. Root cause not yet found (was mid-investigation in
   `apps/api/src/install/installer.ts` when this session pivoted away from manual debugging).

None of these were exotic — they came from following the product's own documented/recommended
recovery path (`doctor` → `rejoin --force`) and normal node lifecycle (re-running the install
command on an existing node, which is a completely ordinary thing an admin would do). A real user
hitting any single one of these would have to SSH into their own server and start reading Docker
internals to recover. That is precisely what swarmy is supposed to make unnecessary.

## Reframing

Individually, items 1-5 above are real bugs and stay open in their own issue files. But the
meta-lesson is a testing-methodology correction, not just a bug list:

- **Going forward, testing must go through the product surface only** — the dashboard's Add Node
  install command, the deploy UI, the blueprint flow. If a step requires SSHing into a node to fix
  something (not just to *read* logs for diagnosis), that is an automatic fail for that surface,
  written up immediately, with no further manual patching to "get past it."
- Manual SSH recovery performed earlier in this session (documented in the linked issues) should
  be read as **evidence of these bugs**, not as an accepted workaround — the fact that recovery
  was possible by hand doesn't make the automatic path acceptable.
- The stale local VM state produced by that recovery work (a swarm that was force-reformed,
  overlay networking broken, one node double-enrolled with the wrong token) is not worth
  preserving or continuing to debug live. See the readiness sweep log (`plans/readiness-sweep-2026-07.md`, in git history) for the reset.

## Suggested fix direction

- `doctor`'s own suggested remediations need to be as reliable as the initial install, since a
  real user has no fallback below them — if `rejoin --force` can hang/corrupt state, it needs a
  timeout + safe rollback, not just a fix for the specific stale-address case (see
  [[rejoin-force-can-corrupt-manager]] for the narrower suggested fix).
- The worker auto-rejoin path needs an integration test asserting it never self-inits a new swarm.
- The installer's REPAIR-mode env-merge logic needs a regression test: re-running the install
  command with a fresh token + fresh mesh key on a node that already has an installation must
  fully replace the mesh config, not silently drop it.

## Audit (2026-10): each item against today's code

| # | Item | State | Where | Needs a real VM for |
|---|---|---|---|---|
| 1 | `rejoin --force` hangs and wedges the sole manager | **Mitigated** in 78b1314e | `apps/agent/src/cli/rejoin.ts` `forceManagerReform()`: node ls, reform, leave and the docker restart are all time-boxed; stale peers are probed first; dockerd is restarted before the reform when wedged or stale; one retry after a deadline. Pure helpers + tests in `cli/rejoin-plan.ts` / `rejoin-plan.test.ts`. | the reform against a real stale-peer raft state |
| 2 | Worker auto-rejoin forms its own one-node swarm | **Fixed** in 78b1314e, b449de17, e7ef3373, ec5d3ceb | `packages/trpc/src/services/swarm.service.ts` `planSwarmMembership()`: never `init` while a connected org node is a live manager. Join tokens and address are read live from that manager. A failed join retries with backoff. A node stuck in a dead foreign swarm reads degraded (QA-065). Covered by `swarm.service.test.ts` ("worker rejoin with NO row but a live manager joins it — never a standalone init"). | the force-a-worker-off integration test (the e2e harness's `reschedule` step covers kill → rejoin, not a reformed manager) |
| 3 | The stale manager address survives and breaks overlay networking (`no VNI provided`) | **Mitigated**: warned after a reform (78b1314e); now flagged by `doctor` (ff0a6a8e) | `apps/agent/src/cli/checks.ts` swarm rung → `stalePeerFinding()` in `cli/rejoin-plan.ts` (tested). The probe is shared with rejoin (`cli/swarm-peers.ts`). It says whether the dead address is this node's own record (only a rebuild clears it) or another manager's (demote and remove it). The node-recovery guide has the matching symptom entry. | clearing it: Docker has no API to rewrite the address; a leave + init rebuild path has to be designed and tested on VMs |
| 4 | Test VMs run out of disk | **Fixed** in 7f15b829 | `scripts/local-vms.sh`: 20 GiB default disks plus a hygiene step (journald 100M, no apt cache, no kernel headers, old kernels removed). See [[vm-disk-chronically-full]] (resolved). | a session on real Lima VMs |
| 5 | A REPAIR re-enroll drops the mesh setup key, silently | **Fixed** in 2d090d63, 72224078, de920728 | The installer now salvages mesh config as one unit (a fresh key replaces URL, driver and CA; a bare re-run keeps them all; `SWARMY_ALLOW_MESH` and the driver are no longer reset). It warns when a key will be ignored: `apps/api/src/install/repair-env-sh.ts`, regression test `repair-env-sh.test.ts`. The agent logs why it skipped the mesh-first join, and doctor warns on a key ignored by `SWARMY_ALLOW_MESH=false` (`apps/agent/src/mesh-startup.ts`). `local-vms.sh` no longer defaults the agent's mesh gate to false while passing a key, and gives each VM its own single-use token and key. Earlier: the printed one-liners carry a key (fb2e6103, 12397d5f / QA-062). | a repair one-liner with a fresh token and key on a mesh-joined VM |

The exact trigger of item 5 in July was never captured. The paths above are every way found to
end up with no mesh key or no mesh client. One remains:

- The legacy `GET /install.sh` (`apps/api/src/install-script.ts`) is still served. It is
  container-only and has no repair mode.
- It re-creates the agent with only the env it was given, so a bare re-run there drops the mesh
  key.
- It also passes the join token and mesh key with `docker run -e`.
- It is still printed by `scripts/seed-dev.ts` and shown in `docs/LOCAL-SWARM.md`. The dashboard
  uses `/install/loader.sh`.
- Retiring it, or serving the loader there, is a separate change.
