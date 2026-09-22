# Controller backup ("Protect the brain") is completely non-functional — the controller container never had `restic` installed or wired up

**Status:** Fixed (2026-09) — controller image now ships a pinned restic; a missing restic yields an actionable error.
**Severity:** Critical — this is swarmy's disaster-recovery mechanism for its own control-plane
database (orgs, nodes, join-token hashes, ingress, deployments). It cannot produce a single
successful backup, for any org, ever, in the deployed configuration. A total controller-loss
scenario has no working recovery path via this feature as shipped.

## Symptom

On `/settings/backup` → "Controller backup" tab ("Protect the brain."): generated and saved a
restore passphrase via the real "Generate passphrase" / "Confirm & save" flow, enabled the
Schedule toggle with destination "Local s3mock (s3)", then clicked "Back up now". The UI produced
a red error toast:

```
Executable not found in $PATH: restic
```

Confirmed directly in the database (`controller_snapshot` table):

```
select * from controller_snapshot order by 1 desc limit 5;
```

returned one row: `targetId=cmrg8jea400324vsbcltl923d`, `resticSnapshotId`/`sizeBytes`/
`durationMs`/`manifestJson` all empty, `status=FAILED`, `startedAt=2026-07-11 10:52:49.797`,
`finishedAt=2026-07-11 10:52:49.983` (~186ms duration — an immediate process-spawn/PATH-lookup
failure, not a real backup attempt), `error=Executable not found in $PATH: "restic"`.

## Root cause

This is architecturally distinct from the working per-stack volume-backup feature, which runs
restic inside a Docker sidecar container launched by the **agent** (which has the node's Docker
socket). Controller backups instead try to exec a **local `restic` binary directly on the
controller process**, and nothing ever puts that binary there.

Call chain:

1. UI: `apps/app/src/components/controllerbackup/backup-now-button.tsx:17-25` fires
   `trpc.controllerBackup.runNow`.
2. Router: `packages/trpc/src/routers/controllerBackup.ts:55`:
   ```ts
   runNow: adminProcedure.mutation(({ ctx }) => runControllerBackup(ctx)),
   ```
3. Service: `packages/trpc/src/services/controllerBackup.service.ts:306-332`,
   `runControllerBackup`, builds the manifest/DB dump and calls `createAndStoreBundle(...)`,
   passing `runner: opts.runner ?? defaultRunner()`.
4. `packages/trpc/src/services/controllerBackup.bundle.ts:70-79`, `defaultRunner()`:
   ```ts
   export function defaultRunner(env: NodeJS.ProcessEnv = process.env): ResticRunner {
     const mode = (env.SWARMY_CONTROLLER_RESTIC_MODE === 'docker' ? 'docker' : 'binary') as
       | 'binary' | 'docker';
     return {
       mode,
       resticPath: env.SWARMY_RESTIC_BINARY,
       image: env.SWARMY_RESTIC_IMAGE ?? DEFAULT_RESTIC_IMAGE,
     };
   }
   ```
   `mode` defaults to `'binary'` unless `SWARMY_CONTROLLER_RESTIC_MODE=docker` is set —
   that env var is referenced **nowhere else in the repo** (not in `apps/api/Dockerfile`, any
   compose file, or any chart), so the deployed default is always `'binary'`.
5. `packages/trpc/src/services/controllerBackup.bundle.ts:100-136`, `runRestic()`:
   ```ts
   if (runner.mode === 'docker') {
     ...
   } else {
     cmd = runner.resticPath ?? 'restic';     // line 117
     fullArgs = args;
   }
   ...
   const child = spawn(cmd, fullArgs, { ... });   // line 121
   ```
   With no `SWARMY_RESTIC_BINARY` set, `cmd` is the literal string `'restic'`, executed via
   Node's `spawn()` directly against the controller process's own `$PATH`.
6. `apps/api/Dockerfile` (the controller's own image, base `oven/bun:1.3-alpine` at both the
   build and runtime stages) **never installs a `restic` binary** — `grep -rn "restic"
   apps/api/Dockerfile` returns zero matches. There is no `restic` anywhere in `$PATH` inside the
   controller container, so the spawn fails immediately, matching the observed
   `Executable not found in $PATH: "restic"` and the ~186ms fail time in the DB.

A misleading comment sits directly above this code
(`controllerBackup.bundle.ts:59-61`):

```ts
/**
 * How restic is run on the controller host. `binary` execs a local `restic`;
 * `docker` runs the pinned image as a short-lived container with the staging dir
 * bind-mounted. Defaults to `binary` (controller image ships restic).
 */
```

The claim "controller image ships restic" is false for the actual shipped `apps/api/Dockerfile`.

A `mode: 'docker'` branch does exist (`controllerBackup.bundle.ts:108-115`) and would instead
shell out to `docker run --rm ... restic/restic:0.16.4 ...` — but nothing in the repo ever sets
`SWARMY_CONTROLLER_RESTIC_MODE=docker` by default, and even if an operator set it manually, the
controller container has no Docker socket mounted (unlike the agent, which does), so that branch
would fail too, just with a different error.

## Why this matters

Every other working backup path in swarmy (per-stack volume backups, confirmed working — see
plan rows 19-20) runs restic inside a Docker sidecar on the node, which has Docker socket access.
Controller backup is the one feature that instead assumes a bare `restic` binary exists inside
the controller's own Alpine-based container — an assumption the controller's own Dockerfile never
fulfills. This isn't a misconfiguration a user could fix from the dashboard: there is no UI path
to install a binary into the controller container, and the "Executable not found in $PATH" error
gives no indication that this is a packaging gap rather than a transient failure. For a feature
literally titled "Protect the brain" — swarmy's own disaster-recovery story for itself — silently
shipping in a state where it can never succeed is a first-order gap against the "no cloud account
needed, seamless" pitch, and against basic disaster-recovery credibility.

## Suggested fix direction

- Either bundle a `restic` binary directly in `apps/api/Dockerfile` (simplest, matches the
  misleading comment's original intent) — e.g. `apk add restic` on Alpine, or a `COPY --from=`
  from the official `restic/restic` image — and this alone fixes the default `'binary'` mode with
  zero env-var configuration required.
- Or default `SWARMY_CONTROLLER_RESTIC_MODE` to `'docker'` instead of `'binary'`, matching the
  agent's existing sidecar pattern, and wire the controller's Docker socket into its container
  (deploy-manifest change) — more consistent with how volume backups already work, but a bigger
  architectural change than just installing a binary.
- Either way, add a startup/health check (or a "Back up now" pre-flight check) that surfaces a
  clear, actionable error ("restic is not available on the controller — see docs") rather than
  the current raw Node `spawn` ENOENT-style message, so this doesn't silently ship broken again in
  the future.
- Add an integration test that actually calls `runControllerBackup` end-to-end against a real (or
  minimally-mocked) controller container image, not just unit-level coverage of `repoUrl`-style
  string logic — this class of bug (a whole feature dead from day one because the base image
  lacks a runtime dependency) is exactly what a real E2E smoke test of the Docker image would
  catch immediately, and it's the same "isn't a rare edge case, always fails" shape as
  [[node-path-backup-destination-always-treated-as-s3]].

## Not yet tested

Whether the `mode: 'docker'` branch works at all if manually enabled (would additionally need a
Docker socket mount into the controller container, not currently part of the deploy manifests —
untested whether that's even present in any `deploy/*.stack.yml`). The "Upgrade to managed
Postgres" data-store option on the same Controller backup page (untested this sweep). The
standalone `bun run restore` CLI referenced in the UI for total-loss recovery (unreachable — no
successful controller backup has ever been produced to restore from).

## Fix applied (2026-09)

- `apps/api/Dockerfile:42-56` — new `FROM restic/restic:0.16.4 AS restic` stage (same version
  as `DEFAULT_RESTIC_IMAGE`, so controller- and agent-written repos stay format-compatible);
  runtime stage adds `ca-certificates` and `COPY --from=restic /usr/bin/restic
  /usr/local/bin/restic`. Verified: on `oven/bun:1.3-alpine` with that COPY, `restic version`
  → `restic 0.16.4 … linux/arm64` and `restic init` on a local repo succeeds (static Go binary).
  Default runner mode `binary` therefore works with zero env config.
- `packages/trpc/src/services/controllerBackup.bundle.ts:107` — `resticMissingMessage(runner)`;
  `runRestic` (:167) maps spawn ENOENT / Bun's `Executable not found in $PATH` to
  "restic is not available on the controller … The swarmy controller image bundles restic — if
  you are running the API outside it (local dev), install restic (macOS: `brew install restic`;
  Debian/Ubuntu: `apt install restic`; Alpine: `apk add restic`; …) or set SWARMY_RESTIC_BINARY".
  Docker mode gets a docker-CLI-specific message. This flows into the toast and the
  `controller_snapshot.error` column. Also corrected the misleading "controller image ships
  restic" comment (now true, and says so precisely).
- Tests: `packages/trpc/src/services/controllerBackup.bundle.test.ts:94` (real spawn of a missing
  binary → actionable message; default runner mode; docker-mode message).

Not done: a full image-level E2E of `runControllerBackup` (would need building the controller
image in CI).
