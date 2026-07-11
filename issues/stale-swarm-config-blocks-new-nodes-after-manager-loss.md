# Once a swarm's manager is permanently lost, every future node registration for that org silently fails to join a swarm — forever, with zero error surfaced anywhere

**Status:** Open — root-caused conclusively via DB inspection + live network check. Not fixed this
session (per standing "document, don't patch" directive).
**Severity:** Critical — this is a permanent, non-self-healing dead end for an entire org, and it is
completely invisible (no dashboard error, no `swarmy-agent doctor` signal, no agent-side log line).

Found immediately downstream of [[install-defaults-to-unpullable-ghcr-image]] while re-verifying
that fix end-to-end. Supersedes an earlier draft of this issue (initially titled
"first-node-swarm-init-orchestration-silently-fails-no-retry"), which mis-attributed the failure —
see "Correction" below for how the investigation got there and what actually turned out to be true.

## Symptom

With the GHCR/onboarding blocker fixed, ran the exact real dashboard one-liner on a fresh Lima VM,
enrolling into the org used throughout this session (`Calum MacRae's team`,
`orgId hRQ9kThFFZIy8sN891ZF1FCxy3zEFirr`). Install completes fully: Docker present, systemd backend,
agent running, mesh connected, controller session registered, dashboard shows the node live with
real metrics.

But the node never joins a swarm, indefinitely:

```
$ swarmy-agent doctor
 ● Docker Swarm   swarm state: inactive
     Not in a swarm. Once the agent registers, the controller orchestrates the join automatically.
     If it never happens: `swarmy-agent rejoin`.

$ docker info --format '{{json .Swarm}}'
{"NodeID":"","NodeAddr":"","LocalNodeState":"inactive","ControlAvailable":false,...}
```

Dashboard shows the node's role as "worker" (not manager) despite it being the only node currently
enrolled and "Automatic" role selection — a detail that turned out to be the key clue (see below).

## Root cause

The org already had a **`swarm_config` row from an earlier, since-torn-down test environment**
(this session's earlier two-node local VM setup, discarded per the methodology correction in
`plans/readiness-sweep-2026-07.md`). Confirmed by reading the table directly:

```
$ psql "$DATABASE_URL" -c 'SELECT "orgId","swarmId","managerNodeId","managerAddr" FROM swarm_config;'
                orgId                 |          swarmId          |       managerNodeId       |    managerAddr
--------------------------------------+---------------------------+---------------------------+--------------------
 hRQ9kThFFZIy8sN891ZF1FCxy3zEFirr     | xgyt5lvteuly7ztw73tzm4eo2 | cmrfamg67000j4vsbue4mcmlc | 100.71.26.140:2377
```

That `managerAddr` is a NetBird mesh IP belonging to a Lima VM that no longer exists. Confirmed dead
with a direct, read-only network check from a *different* live VM on the same mesh:

```
$ nc -zv 100.71.26.140 2377
nc: connect to 100.71.26.140 port 2377 (tcp) failed: No route to host
```

`swarm_config` is **org-scoped DB state, independent of which VMs happen to exist** — tearing down
the VMs that made up the old swarm does not clear this row. So every subsequent node registration
for this org — including a brand new node that has never seen a swarm before — takes the **"join an
existing swarm"** branch of `orchestrateSwarmMembership()`
(`packages/trpc/src/services/swarm.service.ts:106-140`), not the "init a new swarm" branch, because
the code only checks whether *a* `SwarmConfig` row exists for the org, not whether its recorded
manager is actually reachable:

```js
const cfg = await db.swarmConfig.findUnique({ where: { orgId } });
if (!cfg || !cfg.swarmId) {
  // init branch — never reached here, cfg already exists
}
// join branch — reached here every time, using cfg.managerAddr = a dead IP
const role = args.roleHint === 'manager' ? 'manager' : 'worker'; // explains the "worker" role in the dashboard
...
const res = await hub.dispatch(nodeId, SWARM_COMMAND, { mode: 'join', role, managerAddr: cfg.managerAddr, token }, { timeoutMs: 60_000 });
```

This is dispatched to the agent, which attempts `docker swarm join --advertise-addr ... <dead
managerAddr>` (`apps/agent/src/handlers/swarm.ts` → `applySwarmJoin()`). That call can only ever
fail (no route to host) — there is no retry, no fallback to re-`init`, and no way for the org to
recover short of manually clearing the stale `swarm_config` row (a DB-level fix, not something
reachable from the product surface at all).

## Why the failure is completely invisible (a compounding, independent bug)

Root-causing this took direct DB and network inspection because **every layer that should have
surfaced the failure is silent**:

- **Agent side:** `apps/agent/src/executor.ts` and `apps/agent/src/handlers/swarm.ts` contain *zero*
  logging calls (`grep -n "console\.\|logger\."` on both files returns nothing). The generic command
  runner (`executor.ts:290-307`, `run()`) does correctly send a `commandResult` back to the
  controller on both success and failure — so the failure *is* reported over the wire — but nothing
  about it ever reaches `journalctl`, so a user watching the agent's own logs sees nothing at all,
  win or lose.
- **Daemon side:** the command dispatch itself, `void handleCommand(docker, conn, envlp)`
  (`apps/agent/src/daemon.ts:324`), is fire-and-forget with no `.catch()` — if anything threw before
  reaching the try/catch inside `run()`, it would be an entirely silent unhandled rejection.
- **Controller side:** `orchestrateSwarmMembership(...)` is itself called fire-and-forget from
  `handleRegister` (`apps/api/src/gateway/protocol-handlers.ts:338-351`) as
  `void orchestrateSwarmMembership(...).catch(err => console.error(...))` — so a rejection (e.g. the
  join command failing) is logged, but **only to the dev server's own stdout**, which isn't
  persisted anywhere this session had access to (no log file, no dashboard surfacing, nothing
  queryable). In a real deployment this would depend entirely on whatever ops discipline the
  operator has around capturing their own server's stdout — swarmy itself does not persist or
  surface it.
- **`swarmy-agent doctor`:** its "not in a swarm" message is identical whether orchestration was
  never attempted, is still in flight, or has already failed outright — there is no distinction
  between "wait longer" and "this will never succeed," so the doctor cannot tell a user what's
  actually wrong.

## Correction from the original draft of this issue

The first version of this writeup (before DB/network inspection) concluded the swarm-join *dispatch
itself* never reached the agent at all, based solely on the total absence of any swarm-related line
in `journalctl`. That conclusion was **not warranted** — as shown above, the agent has no logging
for command execution regardless of outcome, so log silence proves nothing about whether a dispatch
arrived. The real story, once the DB was inspected directly, is a stale-manager-address join failure
that *was* correctly attempted and correctly reported back over the wire — it just vanished into
logging gaps at every subsequent layer. Documenting this correction explicitly because presenting
the earlier, wrong conclusion with unwarranted confidence would have pointed any future fix at the
wrong code (dispatch/registry logic, which the evidence shows is fine) instead of the real defects
(stale-manager detection + logging gaps).

## Why this matters for the "magical install" bar

This is not a one-off local-testing artifact. **Any real production swarm that permanently loses its
manager** (hardware failure, an operator accidentally destroying the wrong VM/droplet, a cloud
provider incident) ends up in exactly this state: the org's `swarm_config.managerAddr` still points
at a dead host, and every node added afterward — via the now-fixed, otherwise-working install
flow — will silently fail to ever join a swarm, with no error the user can see anywhere in the
product. There is no in-product path back from this short of directly editing the database.

## Suggested fix direction

- Before dispatching a `join`, verify `cfg.managerAddr` is actually reachable/healthy (e.g. a quick
  TCP check, or checking whether any node currently reports itself as that swarm's manager); if not,
  treat the org as having no usable swarm and fall back to `init` on the registering node (with an
  explicit "swarm manager was unreachable — this node started a new swarm" note surfaced to the
  dashboard, not silently).
- Surface the real orchestration outcome (success, and specifically *why* on failure) on the node's
  dashboard page instead of only a server-side `console.error`.
- Add logging to `apps/agent/src/executor.ts`'s `run()` and to `daemon.ts`'s `handleCommand` dispatch
  site — at minimum, log command type + outcome (success/failure + error message) for every command
  the agent executes. Right now the agent is silent by default for its entire command-execution
  surface, not just swarm join — this will hide many other classes of bug the same way.
- Make `swarmy-agent doctor` distinguish "orchestration never attempted," "in flight," and "attempted
  and failed: <reason>" for swarm state, rather than one generic "not in a swarm" message for all
  three.
- Separately: an org-level admin action ("reset swarm configuration" / "this org's swarm is
  unrecoverable, start fresh") would give operators a supported, in-product recovery path instead of
  requiring direct DB access — this exact scenario (permanent manager loss) is not hypothetical for
  a real deployment.

## Confirmation: a genuinely fresh org works correctly (2026-07-11)

To keep verifying without touching either polluted org's DB state, created a brand-new account/org
("Sweep Tester's team") through the real, in-product signup flow (`/login` → "Sign up" — there is no
in-app multi-org support for an existing account, so this was the only product-surface way to get an
org with zero prior `swarm_config` history). Provisioned a genuinely fresh Lima VM and ran the exact,
unmodified one-liner the dashboard generated for that org (only the usual local-dev URL env overrides
— `SWARMY_CONTROLLER_URL`/`SWARMY_INSTALLER_URL`/`SWARMY_BINARY_BASE_URL` pointed at the dev
controller's LAN address — no swarmy code touched). Result:

```
● Docker Swarm         active (manager), advertising 192.168.5.15
```

Confirmed in the dashboard too: "Your cluster's healthy", 1/1 nodes online, node shown under
"Control plane" with role `manager`, "1 / 1 manager reachable · single manager". This is the `init`
branch of `orchestrateSwarmMembership()` firing correctly, exactly as expected for an org with no
`swarm_config` row at all — **conclusively confirming the root cause above**: the bug is specifically
stale/dead `managerAddr` pollution on an org that already has a row, not a defect in the init/first-node
path itself. The install pipeline (row #1's fix) plus a clean org together do reach a healthy,
real swarm with zero manual intervention.

This unblocks the rest of the readiness sweep for testing purposes (continuing under this fresh org),
but the underlying bug is still unfixed and still a real production risk for any org whose manager is
permanently lost — see "Suggested fix direction" above, still outstanding.

## Not yet tested

Whether a second node joining a *healthy, reachable* manager works correctly — not yet exercised via
the real product surface. Also not yet tested: what `swarmy-agent rejoin` actually does in the
stale-manager scenario (deliberately not run, per the standing "no manual recovery" methodology) —
worth checking in a future session whether it has the same reachability blind spot.
