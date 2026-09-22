# The dashboard's install/repair one-liner is fundamentally broken any time the controller's baked public URL isn't reachable from the target node — exactly the situation the UI's own "swap localhost" instruction says to expect

**Status:** Fixed (2026-09) — every install stage now derives from ONE controller base (the
address the node actually used); see "Fix applied (2026-09)" below. Originally root-caused via
source + live reproduction.
**Severity:** Critical — this directly breaks the exact promise the whole product is built around
("magical install... straight to deploying stacks... no dialing into a machine"). The one-line
install/repair command copy-pasted straight from the dashboard — the primary onboarding and
recovery mechanism — silently fails on any node that isn't literally the same machine the browser
is pointed at, unless the operator already knows about three undocumented shell env var overrides
that appear nowhere in the UI.

## Symptom

A second, pre-existing org ("Calum MacRae's team") had a node (`lima-swarmy-node-1`) shown as
"degraded" on Infrastructure → Nodes. Opened the node detail page, which shows a "Repair this node"
panel with copy: *"lima-swarmy-node-1 is offline. If the machine is up but won't reconnect, paste a
repair one-liner on it — the installer detects the existing install, refreshes its credentials,
keeps its identity, and runs the doctor."* — and a ready-to-copy command:

```
curl -fsSL http://localhost:3023/install/loader.sh | SWARMY_JOIN_TOKEN=<token> \
  SWARMY_MESH_SETUP_KEY=<key> SWARMY_MESH_MANAGEMENT_URL=https://api.netbird.io \
  SWARMY_MESH_DRIVER=netbird sh
```

with the caption *"Run it on lima-swarmy-node-1 (swap localhost for the controller's reachable
address). Shown once."*

Followed that instruction exactly — ran the command on the actual node VM via SSH (explicitly
in-bounds per this sweep's standing "dashboard-generated install one-liners via SSH" permission),
swapping `localhost` for the controller host's real LAN IP as instructed:

```
$ curl -fsSL http://192.168.11.87:3023/install/loader.sh | SWARMY_JOIN_TOKEN=... sh
curl: (7) Failed to connect to 192.168.11.87 port 3023 after 0 ms: Couldn't connect to server
```

Port 3023 (the dashboard) turned out to be bound to IPv6 loopback only in this dev setup — a local
dev-environment quirk, not a swarmy bug (confirmed via `lsof`: `[::1]:3023` vs `*:3021` for the
actual API). Retried against port 3021 (the API server, which does serve `/install/loader.sh` and
is reachable from the node):

```
$ curl -fsSL http://192.168.11.87:3021/install/loader.sh | SWARMY_JOIN_TOKEN=... sh
curl: (7) Failed to connect to localhost port 3021 after 0 ms: Couldn't connect to server
swarmy: failed to download installer
```

Even after correctly swapping the address for the *outer* curl, the loader script — once running on
the remote node — still tries to fetch stage 2 from `localhost:3021` and fails identically to the
first attempt. Swapping the address for the one-liner the UI hands you does not actually fix
anything past the very first network hop.

## Root cause

The install/repair flow is two-stage, and every stage after the first re-derives its own target URL
from a single server-side config value rather than from the address the client actually used to
reach it — and the dashboard never lets the operator override that.

1. **The dashboard-generated command** — `apps/app/src/components/onboarding/install-command-panel.tsx:16,26`:
   ```ts
   const origin = typeof window !== 'undefined' ? window.location.origin : '';
   ...
   return `curl -fsSL ${origin}/install/loader.sh | SWARMY_JOIN_TOKEN=${token} ${roleEnv}${labelEnv}${meshEnv}sh`;
   ```
   `origin` is `window.location.origin` — wherever the *browser* is pointed, which is why the UI's
   own copy has to tell the user to manually swap it for a remote node. This is the only URL the
   generated command lets you override.

2. **Stage 1 (loader.sh)** — `apps/api/src/install/loader.ts:renderLoader()` bakes:
   ```sh
   SWARMY_INSTALLER_URL="${SWARMY_INSTALLER_URL:-${installerUrl}}"
   ```
   where `installerUrl = ${controllerUrl}/install/${version}/install.sh`, and `controllerUrl` comes
   from `apps/api/src/index.ts:99` → `installerOptionsFor(version)` → `env.CONTROLLER_PUBLIC_URL`
   (`apps/api/src/env.ts:12`, defaulting to `'http://localhost:3021'` when unset). This is a single,
   server-wide, request-independent value — **not** derived from the Host header or address the
   loader was actually fetched from. Swapping the outer curl's address does nothing to this value;
   it is baked at server-response time regardless of how the loader was reached. This is the exact
   failure reproduced above.

3. **Stage 2 (install.sh)** — even after overriding `SWARMY_INSTALLER_URL` to get stage 2 to
   download at all, `apps/api/src/install/installer.ts:60` bakes a *second* independent default the
   same way: `CONTROLLER_URL="${SWARMY_CONTROLLER_URL:-${controllerUrl}}"` — same
   `env.CONTROLLER_PUBLIC_URL` source, same problem, needed for the agent to know where to phone
   home post-install.

4. **Agent binary download** — `apps/api/src/index.ts:87` (`installerOptionsFor`) sets
   `binaryBaseUrl: env.AGENT_BINARY_BASE_URL`, which (`apps/api/src/env.ts:29-31`) defaults to
   `${CONTROLLER_PUBLIC_URL}/install/bin` — the same baked value a third time, needed by
   `installer.ts:66`'s `BINARY_BASE_URL="${SWARMY_BINARY_BASE_URL:-${binaryBaseUrl}}"` to fetch the
   actual agent binary.

None of `SWARMY_INSTALLER_URL`, `SWARMY_CONTROLLER_URL`, or `SWARMY_BINARY_BASE_URL` appear anywhere
in `install-command-panel.tsx`'s generated command — the one thing a real user or operator would
ever actually copy-paste.

**Confirmed this is a known, already-worked-around problem internally**: `scripts/local-vms.sh:158-180`
(`enroll_node()`) explicitly bypasses the two-stage loader entirely and fetches `install.sh`
directly, then manually threads `SWARMY_CONTROLLER_URL` and `SWARMY_BINARY_BASE_URL` — with an
explicit code comment: *"pass SWARMY_CONTROLLER_URL / SWARMY_BINARY_BASE_URL so it works no matter
what CONTROLLER_PUBLIC_URL the controller bakes."* The dev tooling for this exact scenario (multiple
local VMs, controller not reachable at its own baked URL) already had to solve this problem — the
dashboard's own generated command for the equivalent real-world scenario (any node not on the
controller's own host) never got the same fix.

**Confirmed the workaround fully closes the loop**, live, via SSH on the actual degraded node:
```
curl -fsSL http://192.168.11.87:3021/install/loader.sh | \
  SWARMY_INSTALLER_URL=http://192.168.11.87:3021/install/0.0.0/install.sh \
  SWARMY_CONTROLLER_URL=http://192.168.11.87:3021 \
  SWARMY_BINARY_BASE_URL=http://192.168.11.87:3021/install/bin \
  SWARMY_JOIN_TOKEN=... SWARMY_MESH_SETUP_KEY=... SWARMY_MESH_MANAGEMENT_URL=... SWARMY_MESH_DRIVER=netbird sh
```
completed cleanly through binary install, systemd setup, and mesh join
(`swarmy-agent doctor --repair` output: agent binary installed, daemon running, Docker reachable,
controller HTTP reachable, mesh connected). The run's final failure ("controller rejected auth:
invalid join token") was the join token having expired (confirmed afterward on Settings → Join
tokens: `USES 0/1`, status `expired` — it was never actually consumed by an earlier attempt, it
simply outlived its TTL across the several minutes of retries) — not a new bug, and not related to
the URL-override issue this file documents.

## Why this matters

This isn't an edge case — it's the *default* case for the product's core value proposition. Every
node other than the controller's own host needs this to work, and it silently doesn't, with an
error message ("failed to download installer" / connection refused on `localhost`) that gives no
hint that the fix is three specific, undocumented env vars. The dashboard UI's own copy
("swap localhost for the controller's reachable address") actively teaches the user the *wrong*
partial fix — one that isn't sufficient — because it only ever addresses the first of four broken
hops. Anyone following the dashboard's own instructions to repair or add a real second node hits
this immediately.

## Suggested fix direction

Best fix: have `installer.ts`/`loader.ts` derive their embedded URLs from the actual request (e.g.
the `Host`/`X-Forwarded-Host` header the loader/installer route was hit with) instead of a single
static `CONTROLLER_PUBLIC_URL`, the same way `window.location.origin` already does client-side for
the outer curl — so the loader and installer inherently agree with whatever address successfully
reached them, with no override needed at all.

If that's not viable short-term (e.g. because `CONTROLLER_PUBLIC_URL` needs to stay authoritative for
production DNS-based deployments), then at minimum have
`install-command-panel.tsx:26` thread `SWARMY_INSTALLER_URL`, `SWARMY_CONTROLLER_URL`, and
`SWARMY_BINARY_BASE_URL` (all derived from the same `origin` the outer curl already uses) into the
generated command, mirroring exactly what `local-vms.sh`'s `enroll_node()` already does — so the
one thing a user actually copies just works, the same way the "swap localhost" instruction implies
it should.

Add an integration test that renders the install/repair command for an `origin` different from
`CONTROLLER_PUBLIC_URL` and asserts all four URLs (outer curl, loader's installer URL, installer's
controller URL, installer's binary base URL) resolve consistently to the reachable address — this is
exactly the kind of "one value baked in four places, only one of them overridable" bug a single
shared-derivation assertion would catch.

## Not yet tested

Whether this reproduces identically in a real (non-local-dev) deployment where `CONTROLLER_PUBLIC_URL`
is a real public DNS name — in that case the *outer* curl and the *baked* URL would already agree
(both `https://your-swarmy-domain.com`), so this specific failure mode may only manifest for
local/private-network multi-node testing (matching what `local-vms.sh`'s comment already implies) —
not confirmed against a real DigitalOcean-hosted deployment yet, planned as part of this sweep's
later multi-region phase.

**Update — retested with a fresh, unexpired token from Settings → Join tokens (via the dashboard's
"Add a node" flow, `TOKEN_LABEL` default, all three URL overrides re-applied):** the run completed
cleanly through `swarmy-agent doctor --repair` reporting **"Controller session — registered as
cmrfn07qd001e4vsb8mbv6prq (session v3)"** — full auth success, conclusively closing out this issue's
own scope. The dashboard now shows live CPU/memory telemetry flowing for the node (proof the agent
↔ controller HTTP link is genuinely live), but the node still never reaches "online" —
`swarmy-agent doctor` reports `Docker Swarm: swarm state: inactive — Not in a swarm. Once the agent
registers, the controller orchestrates the join automatically.` and it never does. This is very
likely a recurrence of the already-documented, separate
[[stale-swarm-config-blocks-new-nodes-after-manager-loss]] bug for this specific org (this node's
org previously had a working swarm that was lost, matching that bug's exact trigger condition) —
not a new symptom of the URL-override issue this file documents, and not independently re-root-caused
here. Mesh (netbird) also still reports "0/7 peers up" despite connecting successfully, which may or
may not be related — not investigated further, out of scope for this file.

## Fix applied (2026-09)

**One base URL, threaded through every hop.**

- **Loader** (`apps/api/src/install/loader.ts:63` `renderLoader`): resolves a single
  `SWARMY_CONTROLLER_URL` from `--controller <base>` (or `--controller=<base>`), then
  `SWARMY_CONTROLLER_URL` env, then the baked default. It derives `SWARMY_INSTALLER_URL`
  (`<base>/install/<v>/install.sh`) and `SWARMY_BINARY_BASE_URL` (`<base>/install/bin`, unless the
  operator pinned a CDN via `SWARMY_AGENT_BINARY_BASE_URL`) from that base and exports both, so the
  installer and agent dial back to the same address. It also accepts `--token`, forwards every other
  arg, rejects non-http(s) bases, and prints a warning to stderr when the base is loopback. The baked
  default is single-quoted, so nothing in it can break out into the shell.
- **Installer** (`apps/api/src/install/installer.ts`): accepts `--controller`/`--token` for a direct
  run (~:93). Unless a binary CDN is configured, it re-derives `BINARY_BASE_URL` from the resolved
  `CONTROLLER_URL` (`binaryBaseFromController`, :61). Its body stays request-independent so the
  loader's pinned sha256 is stable. Also fixed a latent `set -u` crash: `DROP_AGENT_STATE` was
  unset on the docker backend (:173).
- **Server-side resolution** (`packages/core/src/controller-url.ts:112`
  `resolveControllerPublicUrl`): a real (non-loopback) `CONTROLLER_PUBLIC_URL` is authoritative.
  When it is unset or loopback, the resolver tries `X-Forwarded-Host`/`-Proto` and RFC 7239
  `Forwarded`, then `Origin`, then `Host`, and takes the first non-loopback one. Every
  header-derived value is checked against a strict host[:port] grammar because the result ends up
  in shell bodies. If everything resolves to loopback, it returns `loopback: true` plus a
  `warning` telling the operator to set CONTROLLER_PUBLIC_URL.
  - `/install/loader.sh` and the legacy `/install.sh` bake the request-resolved base
    (`apps/api/src/index.ts:73` `requestControllerUrl`).
  - `nodes.generateJoinToken` now returns `install: { url, source, loopback, warning }`
    (`packages/trpc/src/services/token.service.ts:47,109`).
- **Dashboard one-liner** (`apps/app/src/components/onboarding/install-command-panel.tsx:31`):
  `curl -fsSL <base>/install/loader.sh | SWARMY_JOIN_TOKEN=… sh -s -- --controller <base>`, where
  `<base>` comes from the server. Secrets stay in env, not argv. `ControllerUrlWarning` (:53) shows
  the loopback warning. Add a node, Repair this node and Settings → Join tokens all use the same
  builder. Join tokens previously used the legacy `/install.sh` and dropped the mesh key; it now
  uses the loader and carries the key.
- **Repair panel** (`apps/app/src/components/nodes/node-repair-card.tsx`):
  - Mints a fresh token on demand with a 24h TTL (:19) and shows when it expires.
  - Withdraws the command once the token expires and prompts for a new one.
  - Has a "New command" button to re-mint.
  - The "swap localhost" copy is gone.
- **Actionable token errors** (`apps/api/src/gateway/join-auth.ts:23`): an expired token now reports
  "join token expired - mint a fresh one… (node > Repair)" and an exhausted one reports
  "token exhausted - mint a fresh join token…" (was "invalid join token"). Both fit the 123-byte WS
  close-reason limit, and a test covers that.
- **Dev tooling**:
  - `scripts/local-vms.sh:165` `enroll_node()` now runs the same loader one-liner with
    `--controller`. The workaround that bypassed the loader is gone.
  - `apps/app/vite.config.ts` proxies all of `/install` (was only `/install.sh`) with `xfwd`, so
    the dashboard-origin one-liner also works in dev.

**Tests**:
- `apps/api/src/install/loader.test.ts` runs the rendered loader under a real `sh` with a fake
  `curl`. It asserts that the installer URL, binary base, and dial-back URL all resolve to the
  `--controller` base while the baked default is `localhost`. It also covers the env override, a
  pinned CDN, the loopback warning, checksum refusal, bad or dangling `--controller`, and
  quote-injection in the baked default.
- Installer `sh -n`.
- `packages/core/src/controller-url.test.ts` covers header precedence, the loopback flag, and
  hostile Host/Origin values.
- The new join-auth reason test.
