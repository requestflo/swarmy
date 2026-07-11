# Getting two local test nodes healthy required repeated manual SSH/swarm surgery — that's the failure

**Status:** Open — meta-finding, supersedes the framing of the individual bugs below.

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
  preserving or continuing to debug live. See `plans/readiness-sweep-2026-07.md` for the reset.

## Suggested fix direction

- `doctor`'s own suggested remediations need to be as reliable as the initial install, since a
  real user has no fallback below them — if `rejoin --force` can hang/corrupt state, it needs a
  timeout + safe rollback, not just a fix for the specific stale-address case (see
  [[rejoin-force-can-corrupt-manager]] for the narrower suggested fix).
- The worker auto-rejoin path needs an integration test asserting it never self-inits a new swarm.
- The installer's REPAIR-mode env-merge logic needs a regression test: re-running the install
  command with a fresh token + fresh mesh key on a node that already has an installation must
  fully replace the mesh config, not silently drop it.
