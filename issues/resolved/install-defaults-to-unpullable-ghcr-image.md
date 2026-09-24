# The real, dashboard-generated install command fails for every fresh node — GHCR image is not public, and a working alternative installer is already live but unused by the UI

**Status:** ✅ Fixed and verified (2026-07-11) — see "Fix applied" below.
**Severity was:** Critical — this was step zero. No node could be onboarded via the documented, in-product flow.

## Fix applied (2026-07-11)

User explicitly authorized this specific, scoped fix (not a blanket lifting of the "no code
changes" rule for the sweep). Applied exactly the change suggested below:
`apps/app/src/components/onboarding/install-command-panel.tsx:26` now points the dashboard's
one-liner at `/install/loader.sh` instead of `/install.sh`.

**Verified end-to-end on a fresh Lima VM, through the real, unmodified-except-for-this-one-line
dashboard flow:** Docker installs, the systemd backend is correctly auto-selected (bypassing GHCR
entirely — no image pull attempted), the native agent binary downloads and installs under a real
systemd unit, the agent starts, registers with the controller over WebSocket, and joins the NetBird
mesh. The GHCR `denied` failure described below no longer occurs.

**This unblocks onboarding up to and including mesh connection — but not further.** Immediately
downstream, a second, independent, launch-blocking bug was found: this session's org already had a
`swarm_config` row pointing at a manager address from an earlier, since-destroyed test VM, so every
new node silently attempts to join a permanently dead manager and never reaches a working swarm —
with no error surfaced anywhere. See
[[stale-swarm-config-blocks-new-nodes-after-manager-loss]] for the full, verified root cause — that
issue is now the active blocker for the rest of this sweep (stack deploys, ingress, everything
requiring a working swarm).

## Symptom

Dashboard → Nodes → Add a node → fill in role/labels → "Get my one-liner" produces the real,
literal install command a user is meant to copy-paste:

```
curl -fsSL https://<controller>/install.sh | SWARMY_JOIN_TOKEN=swt_... SWARMY_MESH_SETUP_KEY=... \
  SWARMY_MESH_MANAGEMENT_URL=https://api.netbird.io SWARMY_MESH_DRIVER=netbird sh
```

Run verbatim on a genuinely fresh Ubuntu 24.04 box (Lima VM, confirmed not VM-specific — see below):
Docker installs fine via get.docker.com, daemon starts and verifies fine, then the final step fails:

```
▸ Starting the swarmy agent…
▸ Pulling the agent image (ghcr.io/requestflo/swarmy-agent:latest)…
! Could not pull a newer image; using the local copy if present.
Unable to find image 'ghcr.io/requestflo/swarmy-agent:latest' locally
docker: Error response from daemon: error from registry: denied
denied
✗ Failed to start the agent container.
```

The agent never starts. The node never appears in the dashboard. This is a **100% reproducible,
universal blocker** — not an edge case, not environment-specific.

## Confirmation it's the image, not the VM

```
$ docker pull ghcr.io/requestflo/swarmy-agent:latest    # run directly on the Mac, no VM involved
Error response from daemon: Head "https://ghcr.io/v2/requestflo/swarmy-agent/manifests/latest": denied
```

Same `denied` error with zero swarmy code in the loop at all. The image is not publicly pullable
on GHCR, full stop.

## Root cause: the dashboard links to the wrong (older, weaker) installer — a better one already exists and is already live

There are **two independent, fully-implemented install pipelines** in this codebase today:

1. **`apps/api/src/install-script.ts` → `renderInstallScript()` → served at `GET /install.sh`.**
   This is what the dashboard's "Get my one-liner" actually builds its command against
   (`apps/app/src/components/onboarding/install-command-panel.tsx:26`:
   `` `curl -fsSL ${origin}/install.sh | SWARMY_JOIN_TOKEN=${token} ...` ``). It is the *older,
   simpler* script — Docker-container backend only, no backend selection logic at all. It always
   does `docker pull "$AGENT_IMAGE"` (defaulting to `ghcr.io/requestflo/swarmy-agent:latest`,
   `apps/api/src/env.ts:28`) and dies if the run fails. The file's own header comment says as much:
   > "Deferred (see plan): checksum-pinned two-stage loader, native systemd backend, .deb/.rpm
   > packages, full manager-vs-worker swarm auto-join."

2. **`apps/api/src/install/installer.ts` → `renderInstaller()` → served live at
   `GET /install/loader.sh` and `GET /install/:version/install.sh`** (wired directly in
   `apps/api/src/index.ts`, lines ~54-97 — a real, working, checksum-pinned two-stage loader with
   its own test suites, `apps/api/src/install/systemd.test.ts` and `loader.test.ts`). This is the
   **more capable** installer:
   - `BACKEND="${SWARMY_BACKEND:-auto}"` — auto-detects `systemd` vs `docker`
     (`use_systemd() { have systemctl && [ -d /run/systemd/system ]; }`).
   - The systemd path (`install_systemd()`) downloads a checksum-pinned native agent binary from
     `SWARMY_BINARY_BASE_URL` and runs it under a real systemd unit — **no Docker image, no GHCR
     dependency whatsoever.**
   - Still supports `SWARMY_BACKEND=docker` to force the container path if wanted.

**This second installer is not dead code — it's live, tested, and reachable right now** at
`/install/loader.sh`. It just isn't what the dashboard links to. The fresh Ubuntu 24.04 VM used to
reproduce this bug has a fully working, running systemd (confirmed via a read-only diagnostic:
`which systemctl` → `/usr/bin/systemctl`, `/run/systemd/system` exists, `systemctl
is-system-running` → `running`) — meaning if the dashboard pointed at `/install/loader.sh` instead
of `/install.sh`, this exact box would very likely have auto-selected the systemd backend and
skipped the GHCR dependency entirely.

## Why this matters beyond "one URL is wrong"

This isn't a single missing feature — it's evidence that a real fix was already built (checksum
pinning, systemd backend, proper auto-detection, test coverage) and then never connected to the
one surface real users actually touch. The "magical, one command, no manual intervention" bar the
product is being held to this session is *already met by code sitting in the repo* — it's just
orphaned from the UI.

## Suggested fix direction (not implemented this session)

- Point `apps/app/src/components/onboarding/install-command-panel.tsx:26` at `/install/loader.sh`
  instead of `/install.sh`, so the dashboard's one-liner uses the loader → pinned-installer →
  auto-backend-detection path instead of the old Docker-only script.
- Once that's live and verified working end-to-end (including with `SWARMY_MESH_*` env vars, which
  the newer installer would also need to thread through to the agent — worth double-checking it
  does today), retire `install-script.ts`'s `renderInstallScript()`/`GET /install.sh` entirely
  rather than maintaining two parallel installers.
- Separately/orthogonally: actually publish `ghcr.io/requestflo/swarmy-agent` as a public image (or
  document that `SWARMY_AGENT_IMAGE` must point at a private registry the user has access to) —
  the Docker-container backend is still a legitimate choice for `SWARMY_BACKEND=docker` or
  non-systemd hosts, and it's broken independent of which route serves it.

## Relationship to other findings

This is the root cause underlying the earlier attempt at [[manual-recovery-required-not-magical]]
and supersedes the "start clean, retest the exact one-liner" step of that plan — the clean retest
was done, and it fails at the very first step for a reason with a clear, scoped, low-risk fix
already sitting in the repo. See the readiness sweep log (`plans/readiness-sweep-2026-07.md`, in git history) for where this leaves the
overall sweep.
