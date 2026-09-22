# Docker Swarm's routing mesh (published ports) is unreachable in this Lima VM test environment — environment-level, not a swarmy code bug, but blocks local verification of any published-port feature

**Status:** Open — root-caused as an environment/platform issue via a differential diagnostic test,
not a swarmy source bug. Documented here (rather than silently assumed) because it directly
affects how several other findings in this sweep should be interpreted, and because it currently
blocks fully verifying the in-swarm CI/CD registry feature locally.
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
