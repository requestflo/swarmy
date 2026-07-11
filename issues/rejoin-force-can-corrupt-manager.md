# `swarmy-agent rejoin --force` can hang and leave the sole manager's swarm half-broken

**Status:** Open — not fixed. Reproduced live 2026-07-10; recovered manually (see below), but the
underlying command has no timeout/rollback protection.

## Symptom

Running `swarmy-agent rejoin --force` on the sole manager (to move swarm traffic from a LAN IP
onto the mesh IP, as the agent's own `doctor` command recommends) ran
`docker swarm init --force-new-cluster --advertise-addr <meshIp>` under the hood. That call
failed after a long stall with `context deadline exceeded`, and afterward the node was left in
a broken state:

```
$ docker info --format '{{json .Swarm}}'
{"LocalNodeState":"active","ControlAvailable":false,...}
$ docker node ls
Error response from daemon: This node is not a swarm manager.
```

i.e. Docker believed it was mid-swarm but had no functioning manager/raft — `docker node ls`,
`docker service ls`, and a follow-up `docker swarm leave --force` all hung/failed the same way.

## Root cause

The node's local raft state referenced a **stale `RemoteManagers` address** from a much earlier
test session (`100.71.150.60`, a mesh IP that no longer exists — NetBird had since reassigned a
different address). `--force-new-cluster` tried to migrate/verify against that unreachable
address before timing out, rather than failing fast or ignoring stale peer data it has no way to
reach.

## Recovery performed

1. `systemctl restart docker` — unstuck the wedged in-memory swarm/raft goroutine (confirmed via
   `docker info` flipping back to `ControlAvailable: true` immediately after).
2. Re-ran `swarmy-agent rejoin --force` — this time it succeeded cleanly and re-formed the swarm
   on the mesh IP.
3. The worker (`lima-swarmy-node-2`) then needed a **manual** `docker swarm join` — see
   [[worker-auto-rejoin-forms-standalone-swarm]] — because the controller's automatic
   worker-rejoin orchestration did not actually rejoin it to the reformed cluster.

## Suggested fix

- Add a bounded timeout around the `docker swarm init --force-new-cluster` call in
  `apps/agent/src/cli/rejoin.ts`'s `forceManagerReform()`, with a clear error message
  distinguishing "timed out talking to a stale peer" from other failure modes.
- Consider having the agent (or `doctor --repair`) detect and clear stale `RemoteManagers`
  entries proactively, or restart the Docker daemon itself as a first recovery step when swarm
  state looks wedged, rather than requiring manual `systemctl restart docker`.

## Update 2026-07-10: the "recovery" did not actually clear the stale address, and it broke overlay networking cluster-wide

The manual recovery above (`systemctl restart docker` + `rejoin --force` retry) made the control
API responsive again (`docker node ls`/`docker service ls` work), but it did **not** actually fix
the underlying stale-address problem — it just unblocked the symptom that was easiest to see.

Confirmed via `docker info --format '{{json .Swarm}}'` on **both** nodes, hours later and after
node-2 was manually rejoined with an explicit, correct `--advertise-addr`/manager address:

```
# node-1 (the manager itself):
"RemoteManagers":[{"NodeID":"ypj9zjiy...","Addr":"100.71.150.60:2377"}]   # still the dead IP
# node-2 (the worker, joined explicitly against 100.71.224.116:2377):
"RemoteManagers":[{"NodeID":"ypj9zjiy...","Addr":"100.71.150.60:2377"}]   # same dead IP, somehow
```

Both nodes carry the *identical* stale manager address — including the worker, which joined
using the correct address explicitly on the command line. That rules out "worker cached an old
value" and points at the manager's own raft-carried node/manager record: `--force-new-cluster`
preserves swarm objects (including the manager's self-entry) across the raft reset, and that
preserved object still embeds the pre-incident address. Every node that joins or reconnects
inherits this stale value via gossip, regardless of what address they used to actually dial in.

**Consequence — this breaks ALL overlay networking, not just swarm membership.** Docker's
overlay-network control plane (VXLAN ID allocation, a separate gossip/SWIM protocol from the
Raft/gRPC control API) depends on this address to form its own mesh. With it wrong, the network
control plane never stabilizes:

```
$ docker network create --driver overlay --attachable zztest-net
Error response from daemon: no VNI provided

$ journalctl -u docker | grep VXLAN | tail
# "initialized VXLAN UDP port to 4789" repeating every ~5-10s indefinitely on BOTH nodes —
# a continuous re-init/crash-loop of the networking agent, not a one-time startup log line.
```

This reproduced with a completely fresh, unused network name (`zztest-net`), and after removing
all pre-existing orphaned overlay networks (`blog-net`, `gpgog_db-net`) — ruling out a
network-specific VNI conflict. **Every blueprint/stack deploy that needs a new overlay network
now fails** (confirmed via the WordPress blueprint: secret creation succeeded, stack deploy
failed with `(HTTP code 500) server error - no VNI provided`). Existing networks created before
the incident (e.g. `ingress`) may still work since they don't need fresh VNI allocation.

This is now a genuine blocker for further stack-deploy testing (Task #2 and most of Task #5) —
see [[worker-auto-rejoin-forms-standalone-swarm]] for the related orchestration bug, and the plan
in `plans/` for the proposed full-swarm-rebuild recovery, which requires user authorization since
it's another `docker swarm leave --force` class of action on both nodes.
