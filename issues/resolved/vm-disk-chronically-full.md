# Test VMs (Lima, ~4.8G disk) chronically fill up from Docker/apt/kernel-header bloat

**Status:** Fixed (2026-10) in `scripts/local-vms.sh` — 20 GiB disks by default and a hygiene step
before every enroll. The script is syntax-checked and the hygiene step was run in an
`ubuntu:24.04` container; not yet run end to end on Lima VMs.

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

## Fix applied (2026-10)

`scripts/local-vms.sh`:

- **Disk:** `SWARMY_VM_DISK` defaults to `20G` (was `6G`, about 4.8 GiB usable). It is still an env
  knob. Lima fixes the size when a VM is created, so for an existing, smaller VM `up` and `reenroll`
  print a warning to recreate it (`down`, then `up`).
- **Hygiene before every (re-)enroll** (`prepare_vm`, as root on the VM, idempotent, time-boxed):
  - journald capped with `SystemMaxUse=100M` (`SWARMY_VM_JOURNALD_MAX`) in
    `/etc/systemd/journald.conf.d/zz-swarmy-vm.conf`, then vacuumed. This keeps the cap from this
    session, and the file sorts after the installer's own `swarmy.conf` (500M), so it wins.
  - apt keeps no downloaded `.deb`s: `APT::Keep-Downloaded-Packages "false"` plus a `DPkg::Post-Invoke`
    cleanup, the same rule Docker's ubuntu image uses.
  - Kernel headers never pile up: `path-exclude=/usr/src/linux-headers-*` in `/etc/dpkg/dpkg.cfg.d/`.
    Kernel updates still install, but their header trees are not unpacked. Existing trees are
    removed.
  - Old kernels are removed with `apt-get autoremove --purge` (lock-bounded), then `apt-get clean`.
  - The step prints the VM's disk use.
- **Leaner VMs:** VMs are created with `--containerd=none`. Docker is the engine, so Lima's default
  rootless containerd and nerdctl only cost disk and memory.
- **Docker image bloat** is left to the product: the controller's node-hygiene worker
  (`apps/api/src/workers/node-hygiene.ts`) prunes every 6 h, or after 30 min above 85% disk.
  `swarmy-agent doctor`'s disk rung already warns at 85% and fails at 95%.

Verified in an `ubuntu:24.04` container:

- The apt and dpkg config parse.
- Installing `linux-headers-generic` afterwards leaves `/usr/src` empty.
- No `.deb`s stay cached.
- A re-run is a no-op.

Still to do: re-run on real Lima VMs.
