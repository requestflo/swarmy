# Docker Swarm's routing mesh (published ports) is unreachable in this Lima VM test environment — environment-level, not a swarmy code bug, but blocks local verification of any published-port feature

**Status:** Open, needs a re-test on Lima. `scripts/local-vms.sh` now creates VMs on the e2e
harness's VM-to-VM network (vzNAT + `lima:user-v2`). That fixes the multi-node half of the
routing mesh, but it is unverified with this script. The single-node symptom below never
touches Lima's network, so a networking-mode change can't be expected to fix it. See
"Findings (2026-10)" at the end.

Original status: root-caused as an environment/platform issue via a differential diagnostic
test, not a swarmy source bug. Documented here (rather than silently assumed) because it
directly affects how several other findings in this sweep should be interpreted, and because it
currently blocks fully verifying the in-swarm CI/CD registry feature locally.
**Severity:** Environment-blocking for local testing; **unknown severity for real deployments** —
this needs retesting on the planned DigitalOcean droplets before drawing any conclusion about
whether it affects real swarmy deployments at all.

## Symptom

Enabled swarmy's **In-swarm registry** feature (Deploy → CI & builds tab) via the real UI toggle.
It reported "Live" with a "Registry updated" success toast. Verified via direct node inspection
that this is genuine — a real `registry:2` service is running:

```
$ docker service ls | grep registry
swarmy-registry   replicated   1/1   registry:2   *:5000->5000/tcp
$ docker ps --filter name=registry
137f475babf1   registry:2   Up 4 seconds   5000/tcp   swarmy-registry.1...
```

But the registry's published port is **completely unreachable**, even from the same node:

```
$ curl -s -m 5 -i http://localhost:5000/v2/
(times out, exit 28 — not "connection refused", a full timeout)
$ curl -s -m 5 -i http://10.0.1.5:5000/v2/   # the container's own swarmy-overlay IP
(same timeout)
```

Yet the registry application itself is healthy — querying it from **inside its own container**
works immediately and correctly:

```
$ docker exec swarmy-registry.1... wget -qO- -T 5 http://localhost:5000/v2/
{}
```

## Differential diagnosis: this is not registry- or swarmy-specific

To isolate whether this was something wrong with swarmy's registry configuration specifically, or
a broader platform issue, deployed a completely vanilla, non-swarmy service directly via `docker
service create --publish 8888:80 nginx:alpine` (diagnostic only — not part of swarmy's product
surface, immediately removed after the test, no swarmy code or config touched). Same result:
service converges to `1/1 Running`, but `curl -m 5 http://localhost:8888/` times out identically
(exit 28).

This proves the problem is **Docker Swarm's routing mesh itself** (the IPVS-based load balancer
that's supposed to accept a connection on a published port on any node and forward it to a
healthy task) not functioning in this Lima VM, for any service, regardless of swarmy involvement.
`iptables -t nat -L DOCKER-INGRESS` shows the expected DNAT rules are present (e.g. `tcp dpt:5000
to:172.18.0.2:5000`), so packets are being redirected toward the ingress sandbox network
namespace — but something beyond that point (the IPVS load-balancing hop into the actual
container) isn't completing the connection. Not traced further than this — root-causing Docker's
own routing-mesh internals inside a nested-virtualization Lima VM is out of scope for a swarmy
product readiness sweep.

## Why this matters — and why it's *not* filed as a swarmy application bug

Every other successful test in this sweep that involved network reachability to a container used
**overlay-network service-name DNS from another container on the same overlay** (e.g. the restic
sidecar reaching `s3mock:9090` directly for backups — row 19/20 of the readiness plan), never the
host's published port / routing mesh. That's why backups worked despite this bug: they never
touched the broken code path. Only *this* CI/CD registry test, and the already-documented
[[ingress-never-actually-serves-traffic]] issue's browser-reachability checks, actually exercised
published-port routing mesh — and both found it dead.

This raises an open question for `ingress-never-actually-serves-traffic.md`: some of that issue's
"nothing is listening" symptoms were confirmed with no proxy container running at all (a genuine,
source-confirmed swarmy bug, unaffected by this finding) — but its curl/browser reachability tests
would *also* fail this way even if a proxy had been correctly deployed and listening, because of
this separate routing-mesh problem. That issue's core root causes (##1-4, all source-cited) stand
regardless — but its full reachability picture cannot be considered fully verified against real
infrastructure until retested somewhere the routing mesh actually works.

## Suggested fix direction

Not a swarmy code fix — this is infrastructure the product runs on top of, not something in the
repo. Recommended next steps:

- **Retest identically on the planned DigitalOcean droplets** before treating this as anything
  more than a local sandbox artifact. Lima VMs (this one shows `vmw_vsock_virtio_transport` kernel
  modules loaded, suggesting a nested-virtualization network path) are a known source of unusual
  virtualized-networking edge cases that don't reflect bare-metal/cloud VM behavior.
- If it *does* reproduce on real cloud droplets, that becomes a much more serious, genuinely
  product-relevant finding (routing mesh is core to how any multi-service swarmy deployment
  exposes ports) and would need proper root-causing at that point — not before.
- For local dev/test purposes (Lima/multipass), consider documenting in `docs/LOCAL-SWARM.md`
  that published-port/routing-mesh testing is unreliable in this VM setup, so future testing
  sessions don't waste time re-diagnosing the same environment quirk from scratch.

## Not yet tested

Whether this reproduces on multipass (the other locally-documented VM tool per
[[local-vm-swarm-testing]]-style setups) or only Lima specifically. Whether it reproduces on a
real DigitalOcean droplet — this is the critical next check, planned as part of this sweep's
later multi-region phase anyway.

## Findings (2026-10)

**Lima's default network breaks the multi-node routing mesh. Changed, unverified.**
`scripts/local-vms.sh` used Lima's plain user-mode network (slirp). There every VM has the same
address (`192.168.5.15`) and no path to the other VMs. Without the mesh, two VMs could not form
one swarm, so a published port could never reach a task on another VM. That path needs VXLAN on
UDP 4789 and gossip on 7946 between nodes. With NetBird, the swarm rode the mesh instead.

The e2e cluster harness had already solved this on Lima (`apps/e2e/cluster/lib/provider.ts`,
commits d1f4c0bd and 938cf6db):

- `--network=vzNAT` gives each VM an address the Mac reaches. macOS isolates vzNAT guests from
  each other: ARP fails VM to VM.
- `--network=lima:user-v2`, Lima's virtual switch, carries VM-to-VM TCP and UDP.
- The `user-v2` interface (eth0) is made the default route, so the address the agent advertises is
  one the other VMs reach. The Mac's DHCP search domain is dropped too.

`local-vms.sh` now does the same by default (`SWARMY_VM_NETWORK=fabric`; `slirp` keeps the old
behaviour), and its prepare step prints which interface carries the default route. **Not run
here: no Lima on this machine.** The netplan edit was checked on both cloud-init indent styles in
an `ubuntu:24.04` container. The harness's own steps prove VM-to-VM overlay traffic (`dns`:
container-to-container DNS across nodes). They don't exercise an ingress-mode published port
across nodes, because the edge and the controller publish in host mode.

**The single-node symptom above is not on Lima's network path.** The failing check was
`curl localhost:5000` on the node running the task, plus an nginx control at `:8888`. That
traffic stays inside the VM's kernel: DNAT to the ingress sandbox, IPVS, then the task's veth on
the `ingress` overlay. No Lima NIC is involved, so changing vzNAT, socket_vmnet or a shared
network should not change that result. Evidence on what it was:

- The 2026-09 live verification on fresh Lima VMs (readiness sweep log, in git history) passed
  "CI: link repo → build on Builder node → push → other node pulls + runs" through the registry on
  `localhost:5000`, which is published on the routing mesh. So the routing mesh has worked on
  Lima since.
- The sweep environment had a crash-looping overlay control plane. "initialized VXLAN UDP port"
  repeated every 5-10 s after the stale-manager-address incident ([[rejoin-force-can-corrupt-manager]]).
  QA-066 b (b4e05bdd) reproduced, on Lima, overlay endpoints that dockerd left NO-CARRIER after
  endpoint churn, with VIPs dead from that node. Either matches "DNAT rules present, the
  connection never completes".
- `swarmy-agent doctor` now flags the dead manager address (ff0a6a8e). `overlay-heal.ts` repairs
  NO-CARRIER endpoints, but deliberately never touches `ingress`.

**Next check (on Lima, then a droplet):**

1. `bash scripts/local-vms.sh down && bash scripts/local-vms.sh up` with no mesh.
2. `docker service create --publish 8888:80 nginx:alpine` pinned to node 2.
3. `curl` the port from node 1 and from node 2.
4. If it fails single-node again: `ip netns exec ingress_sbox ipvsadm -Ln` and `ip -d link` inside
   the ingress sandbox (NO-CARRIER?), plus `journalctl -u docker | grep -i vxlan`.
