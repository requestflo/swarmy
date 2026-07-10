---
name: node-recovery
description: Invariants, contracts, and file map for how a swarmy node heals when it goes dark — the swarmy-agent CLI/TUI, the doctor check ladder, the self-healing install one-liner (repair mode + hostname re-adoption), durable session persistence, the recovery beacon (device-pairing approval), and controller-dark rescue backups. Load before touching apps/agent/src/{main,daemon,local-socket}.ts or apps/agent/src/cli/*, apps/api/src/gateway/join-auth.ts, the install/installer.ts repair path, recovery.service.ts, the RecoveryClaim model, or the /agent/recovery/* routes. Product rationale lives in docs/product/node-recovery.md; the operator runbook is docs/NODE-RECOVERY.md.
---

# Node recovery: the CLI, the self-healing one-liner, and the beacon

Read `docs/product/node-recovery.md` for WHY a node that goes dark must always
come home, and `docs/NODE-RECOVERY.md` for the operator-facing runbook. This
skill is the HOW: the invariants every recovery/CLI change must keep, and where
everything lives. This builds directly on the agent dial-out + register/session
contract — load `skill("agent-handlers")` first; this skill owns the
recovery/diagnostics layer on top of it.

## The one-binary contract (do not break)

`swarmy-agent` is BOTH the daemon and the operator CLI. The binary entrypoint is
`apps/agent/src/main.ts` (CLI dispatch), NOT `index.ts` — `index.ts` is now a
thin `runDaemon()` shim kept only so the container image's
`bun run src/index.ts` ENTRYPOINT and `dev:agent` still work. Three hard rules:

1. **No args + no TTY → daemon.** Every already-deployed systemd unit runs the
   binary and must keep daemonizing. (The unit's `ExecStart` is now
   `swarmy-agent daemon`, but bare-exec back-compat still matters for the
   container backend and old units mid-upgrade.)
2. **`--version` prints exactly `swarmy-agent <v> (protocol <p>, commit <c>)`**
   with zero side effects and no env needed — the self-update flow probes a
   freshly-downloaded binary with this string (`handlers/update.ts`).
3. **No args + TTY → the TUI** (falls back to `status` if the native renderer
   can't load). A human typing `swarmy-agent` is asking "how is this node?",
   never "become a daemon on my tty."

## Invariants

1. **Every CLI command works daemon-up AND daemon-down.** The daemon being dead
   is exactly when you reach for `doctor`. Commands talk to a running daemon over
   the local unix socket (`cli/context.ts` `daemonStatus()`), and fall back to
   direct Docker/file inspection when it's gone. Never open a second controller
   WS or re-join the mesh from a CLI command — read the daemon's live state
   instead.

2. **The diagnostics socket is local-only, never a network listener.**
   `local-socket.ts` binds a unix socket at `env.SOCKET_PATH` (next to the state
   file — `/var/lib/swarmy/agent.sock` in prod, `~/.swarmy/…` in dev), mode
   `0600`, owned by the daemon user (root under systemd). It exposes only
   `GET /status` and `POST /reconnect`. Failing to bind it must never take the
   daemon down.

3. **Session persistence is durable, not fire-and-forget.** `daemon.ts`
   `persistSession()` awaits `saveState` with retry + read-back verification and
   logs loudly on failure. This is load-bearing: the original `void saveState()`
   let a rebooted node lose its session and strand on a consumed single-use
   token. Do NOT revert to fire-and-forget.

4. **Re-adoption keeps identity; revocation is the kill switch.** The gateway's
   join-token decision lives in `apps/api/src/gateway/join-auth.ts`
   (`decideJoinAuth`, pure + unit-tested). Order is fixed: revoked/unknown token
   → reject (gates everything); token bound to the existing node for this
   hostname → **re-adopt** (valid even when consumed/expired — it can only
   re-authenticate that one box, never enroll); otherwise fresh enrollment under
   the full expiry + uses-cap policy. A re-adopt does NOT increment `uses`. Never
   let re-adoption or the beacon route around `revokedAt`.

5. **Danger tiers are enforced, not advisory.** green = auto (`doctor --fix`),
   yellow = prompt or `--yes`, **red = typed-phrase confirmation, never
   `--yes`-able** (`rejoin --force`, `reset`, restore-overwrite,
   force-new-cluster). Use `confirmPhrase`/`confirmYesNo` in `cli/context.ts`;
   red-tier actions must refuse on a non-TTY stdin.

6. **The recovery beacon is SSH-host-key trust.** The claim is UNAUTHENTICATED
   (`POST /agent/recovery/claim` — anyone can post). Security = the human
   comparing the fingerprint the machine printed with the dashboard's, PLUS:
   claims only ever attach to an EXISTING node (recovery can never enroll),
   unknown/ambiguous hostnames are pretend-accepted but persist nothing (no
   enumeration), 15-minute expiry, one pending claim per hostname, and the
   credential is delivered ONCE then wiped, bound to the claim secret. See
   `recovery.service.ts` — decrypt the staged credential BEFORE the wipe update.

7. **Rescue backups assume the controller is DARK.** `cli/backup.ts` discovers
   volumes from Docker stack labels (offline), moves data through short-lived
   sidecar containers with volumes bind-mounted (any driver), and takes repo
   credentials from env/prompt — NEVER argv (visible in `ps`). It reuses the
   restic internals exported from `handlers/backup.ts`
   (`runSidecar`/`repoEnv`/`ensureRepo`/`parseSummary`) — see `skill("backups-dr")`.

8. **The compiled binary is hermetic.** Built with
   `--compile-exec-argv=--env-file=/dev/null` so a stray `.env` in the operator's
   cwd can never poison config (only `/etc/swarmy/agent.env` + real env count —
   loaded inside `env.ts`, which is where module-eval order is safe). The TUI's
   native lib is embedded per-platform (see build note below).

## The doctor ladder

`cli/checks.ts` is the ordered ladder mirroring node bring-up:
binary → daemon → docker → controller(HTTP) → session → mesh → swarm →
workloads → disk. Each check: time-boxed (nothing hangs), never throws, returns
`{status: ok|warn|fail|skip, detail, hint?, fix?}`. A `fix` carries a danger
tier and an `apply()`. `doctor` renders the ladder; `doctor --fix` applies green
(+ prompted yellow); `doctor --repair` (used by the installer) auto-applies
green+yellow, re-checks, and prints an install-log-friendly summary; `--json`
feeds support bundles and the crash snapshot. Add a rung by appending a check
function to the array — keep it time-boxed and non-throwing.

## OpenTUI cross-compile (the sharp edge)

`cli/tui.ts` uses `@opentui/core` (imperative API: `createCliRenderer`,
`BoxRenderable`/`TextRenderable`/`SelectRenderable`, `renderer.keyInput`).
`bun build --compile` only embeds the per-platform native package if it's
present in `node_modules`, but `bun install` skips foreign-platform packages
(os/cpu filters). So `scripts/build-agent-binaries.ts` **fetches
`@opentui/core-<platform>` from npm into root `node_modules` before compiling**,
and passes `--define=process.env.OPENTUI_LIBC="glibc"` (our targets are
glibc/Ubuntu-class; musl needs a separate target set). The TUI is loaded via
dynamic import from `main.ts` inside a try/catch so a missing native lib
degrades to `status`, never a broken binary. Always keep a `--no-tui`/plain
path.

## File map

| Concern | Where |
|---|---|
| CLI dispatch (binary entrypoint; `--version`, TTY→TUI, no-args→daemon) | `apps/agent/src/main.ts` |
| Daemon: dial-out, session persistence, swarm watchdog, recovery beacon | `apps/agent/src/daemon.ts` |
| Daemon-mode shim (container ENTRYPOINT / dev:agent back-compat) | `apps/agent/src/index.ts` |
| CLI↔daemon unix socket (`/status`, `/reconnect`) | `apps/agent/src/local-socket.ts` |
| Doctor check ladder (time-boxed, tiered fixes) | `apps/agent/src/cli/checks.ts` |
| CLI plumbing: socket client, controller probe, prompts, flag parse | `apps/agent/src/cli/context.ts` |
| Commands | `apps/agent/src/cli/{status,doctor,reconnect,rejoin,mesh-cli,backup,logs,support-bundle,update-cli,reset,help}.ts` |
| OpenTUI dashboard (overview/workloads/logs/backup tabs) | `apps/agent/src/cli/tui.ts` |
| Env-file fallback load + `SOCKET_PATH` | `apps/agent/src/env.ts` |
| Join-token decision: reject / re-adopt / enroll (pure, tested) | `apps/api/src/gateway/join-auth.ts` (+ `.test.ts`) |
| Register handshake wiring the decision | `apps/api/src/gateway/protocol-handlers.ts` (`handleRegister`) |
| Installer repair mode + `OnFailure` snapshot unit | `apps/api/src/install/{installer,systemd}.ts` |
| Recovery claim state machine (submit/poll/resolve/list) | `packages/trpc/src/services/recovery.service.ts` (+ `.test.ts`) |
| Recovery HTTP routes (unauthenticated, agent-facing) | `apps/api/src/index.ts` (`/agent/recovery/{claim,poll}`) |
| `RecoveryClaim` model | `packages/db/prisma/schema/cluster.prisma` |
| Operator UI: repair one-liner + approve/deny banner | `apps/app/src/components/nodes/{node-repair-card,recovery-claims-banner}.tsx` |
| Binary build: native-lib fetch, libc/env-file defines | `scripts/build-agent-binaries.ts` |

## Recipes

**Add a doctor check.** Append a `check*` function to the array in
`cli/checks.ts`. Return `{id, title, status, detail, hint?, fix?}`; keep it
inside its own time-box and never throw. If it can self-heal safely, attach a
`fix` with the right danger tier.

**Add a CLI command.** Add a `case` in `main.ts` (dynamic-import the impl so
startup stays lean), write `cli/<name>.ts`, and if it's destructive gate it with
`confirmPhrase` (red) or `confirmYesNo` (yellow). Add a line to `cli/help.ts`.

**Change the beacon / claim flow.** Edit `recovery.service.ts` (the pure state
machine — extend its `.test.ts`) and, if the wire shape changes, the two routes
in `apps/api/src/index.ts` and the poster in `daemon.ts`. Keep the four rails
from invariant 6 intact.

**Touch the repair one-liner.** `install/installer.ts` renders the shell script;
`bash -n`/`sh -n` the rendered output (see the `apps/api/src/install/*.test.ts`
golden tests) and keep REPAIR-mode detection (env-file/state/container present)
before enrollment.

## Verification

- `bunx turbo run typecheck --filter=@swarmy/agent` after any agent change.
- `apps/agent` + `packages/trpc` (recovery.service.test) + `apps/api`
  (join-auth.test, install golden) test suites.
- Cross-compile + smoke on a real Linux box: `bun run build:agent-bin`, serve
  via the controller, `swarmy-agent --version` / `doctor` / (fake-TTY) TUI on a
  Lima VM — the native OpenTUI lib only surfaces problems off-macOS.
