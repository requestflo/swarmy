# Worker that's forced off a reformed swarm self-inits a standalone swarm instead of rejoining

**Status:** Open — not fixed. Reproduced live 2026-07-10; recovered manually.

## Symptom

After the manager (`lima-swarmy-node-1`) had its swarm force-reformed (see
[[rejoin-force-can-corrupt-manager]]), the worker `lima-swarmy-node-2` was orphaned from the old
cluster ID. Running `swarmy-agent rejoin --force` on it correctly ran `docker swarm leave
--force`, and the CLI's own output said:

> The agent's swarm watchdog restarts the daemon now; the fresh registration lets the controller
> re-orchestrate the join.

But instead of the controller re-joining it as a worker to node-1's swarm, node-2 came back up
as the **sole manager of its own brand-new independent swarm**:

```
$ docker info --format '{{json .Swarm}}'   # on node-2, after the "rejoin"
{"NodeID":"xgyt5...","LocalNodeState":"active","ControlAvailable":true,
 "Nodes":1,"Managers":1,"Cluster":{"ID":"lgp8shyfqwbrmmuuauf8t99tq",...}}
```

This left two separate one-node swarms instead of one two-node swarm — node-2 was completely
absent from node-1's `docker node ls`.

## Root cause

Not yet root-caused in code (time-boxed during this session in favor of documenting and manually
recovering). The agent's own comment claims "the controller re-joins online workers
automatically," but the observed behavior suggests either:
- the agent itself defaults to `docker swarm init` (rather than waiting for/requesting a
  controller-issued `docker swarm join` command) when it comes back up off-swarm, or
- the controller's orchestration path that's supposed to issue a fresh worker join token +
  `swarmJoin` command to a freshly-reconnected, off-swarm node isn't actually wired up /
  isn't firing in this code path.

Worth investigating: `apps/agent/src/daemon.ts`'s swarm watchdog logic, and whatever handles
`swarm === 'pending'` on the controller side in `apps/api/src/gateway/protocol-handlers.ts`
(there's a related early-return for `swarm === 'pending' || swarm === 'error'` in
`apps/agent/src/cli/rejoin.ts` worth reading in context).

## Recovery performed

Manually, from the manager: `docker swarm join-token -q worker`, then on node-2:
`docker swarm leave --force` followed by `docker swarm join --token <token> <managerMeshIp>:2377
--advertise-addr <node2MeshIp>`. Confirmed `docker node ls` on the manager then showed both
nodes `Ready`. Removed the stale `Down` duplicate entry for node-2's old identity with
`docker node rm`.

## Suggested fix

Root-cause why the controller's automatic worker-rejoin orchestration doesn't fire (or why the
agent defaults to self-init instead of waiting for it), and add an integration test that forces
a worker off-swarm and asserts it ends up rejoined to the *same* cluster rather than forming its
own — this is exactly the multi-node self-healing story the platform is supposed to provide
automatically.
