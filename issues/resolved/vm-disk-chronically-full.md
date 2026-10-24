# Test VMs (Lima, ~4.8G disk) chronically fill up from Docker/apt/kernel-header bloat

**Status:** Open — environment/provisioning gap, not a swarmy code bug. Worked around manually
each time it's hit during this session's testing.

## Symptom

Both `swarmy-node-1` and `swarmy-node-2` (Lima VMs, `~/.lima/swarmy-node-*`) are provisioned
with only ~4.8G of effective disk. Across this testing session both repeatedly hit 95–100% full,
at different times from different causes:

- journald growth (fixed earlier this session with a `SystemMaxUse=100M` cap — held for the rest
  of the session).
- Docker image/volume bloat from repeated install/test cycles (`docker image prune -af` freed
  ~991MB on node-2 alone from old `wordpress:6.7-apache` layers).
- General OS/apt-cache/kernel-header accumulation (`apt-get clean` +
  `rm -rf /usr/src/linux-headers-*` freed real space on node-1 earlier this session).

A full disk manifests as confusing, unrelated-looking failures — e.g. `curl: (23) Failure
writing output to destination` when downloading the agent binary during install, which has
nothing to do with the install logic itself and cost real debugging time before the actual cause
(disk full) was found.

## Suggested fix

Either provision the test VMs with more disk headroom (`scripts/local-vms.sh`), or add a
periodic/pre-flight disk-space check + cleanup (`docker system prune`, apt cache clean) to the
VM provisioning script or to `swarmy-agent doctor`, so this doesn't silently recur on every
extended local test session.
