# A failed backup snapshot gives zero indication of why it failed, even though the real error is already captured server-side

**Status:** Fixed (2026-09) — see "Fix applied" below. Previously: root-caused via source (backend + frontend), confirmed via a live reproduction.
Not fixed this session (per standing "document, don't patch" directive).
**Severity:** Minor/UX — does not block the backup feature itself (the ad-hoc backup-execution
path works correctly end-to-end — see row 12 of the readiness sweep log (`plans/readiness-sweep-2026-07.md`, in git history)), but makes
every failure opaque to the user, which cuts against the governing directive's "light touch"
bar.

## Symptom

Triggered an ad-hoc "Back up now" against a real Docker volume
(`littleworld_main-cache-data`) targeting a deliberately-unreachable external S3 destination
(`https://s3.example.com`, dummy credentials — see row 12 of the readiness plan). The snapshot
row went `RUNNING` → `FAILED` within a few seconds, exactly as expected given the fake endpoint.
Clicking the failed row produced no expandable detail, tooltip, or error text anywhere in the
UI — just the bare "FAILED" status badge. There is no way, from the dashboard alone, to tell
*why* a backup failed (wrong credentials? unreachable host? disk full? permissions?) — a user
would have to already have node/log access to find out, which is exactly the kind of thing
swarmy's dashboard exists to make unnecessary.

## Root cause

This is a frontend-only gap — the backend already does the right thing.

**Backend captures the real error:** `packages/trpc/src/services/backups.service.ts:467-476`,
the `backupVolume` mutation's catch block, persists the failure straight onto the snapshot row:

```js
data: { status: 'FAILED', error: e instanceof Error ? e.message : String(e), finishedAt: new Date() }
```

The underlying message originates from the node agent itself —
`apps/agent/src/handlers/backup.ts:272-274` throws `res.stderr.trim() || restic backup exited
${exitCode}` when the restic sidecar container fails, which for this reproduction would be
restic's own connection/DNS-failure output against `s3.example.com`. This is stored in
`Snapshot.error String? @db.Text` (`packages/db/prisma/schema/backups.prisma:51`).

**It's already on the wire:** `SnapshotView` (`backups.service.ts:52-63`) includes `error:
string | null`, and `listSnapshots` (same file, line 518) maps `error: r.error` into every row
it returns. Nothing extra needs to be added to any tRPC procedure — the field is already there
for any caller.

**The frontend drops it before it ever reaches the UI:**
`apps/app/src/components/backups/snapshot-rows.tsx:7-14` — the `SnapshotItem` interface only
declares `id, volume, status, targetName, sizeBytes, startedAt`, no `error` field. The row
render (lines 40-68) shows only a `StatusBadge`, volume name, a status/target/relative-time
line, and size — no click handler, tooltip, or expandable section referencing an error/reason.
The two callers, `estate-snapshots-card.tsx` and `stack-snapshots-card.tsx`, don't select or
pass `error` through either, so it's discarded before `SnapshotRows` ever sees it.

## Why this matters

Every failed backup — misconfigured destination, expired credentials, a genuinely broken
upstream — looks identical in the dashboard: a bare "FAILED" badge with no next step. For a
product whose whole pitch is not needing to drop into node/Docker access to understand what's
going on, this is a real (if minor) gap, and it's an easy one: the data is already flowing to
the client on every `listSnapshots` call, just unused.

## Suggested fix direction

- Add `error: string | null` to `SnapshotItem` in `snapshot-rows.tsx`, thread it through from
  both callers' queries (they likely already select most of `SnapshotView`'s other fields, so
  this may be a one-line addition per caller), and show it — a tooltip or an expandable row on
  `FAILED` status would be enough; no need for a dedicated detail page.

## Not yet tested

Whether the same drop-the-error pattern exists for other backup-adjacent failure surfaces
(scheduled backup runs vs. ad-hoc, managed-database backup/PITR once that feature is unblocked
— see [[managed-postgres-bitnami-image-tag-16-dead]]).

## Fix applied (2026-09)

The captured error is now shown on every failed-run surface, via one shared expandable
component — `apps/app/src/components/backups/snapshot-failure-reason.tsx` (collapsed to one
truncated `failed: …` line in the offline tone; tap to expand the full restic/agent text).

- Volume snapshots (stack Backups tab + `/backups` estate list): `SnapshotItem` gained
  `error?: string | null` and `SnapshotRows` renders the reason under `FAILED` rows
  (`apps/app/src/components/backups/snapshot-rows.tsx`). Both callers already pass the full
  `SnapshotView`, so no query changes were needed.
- Controller backups (`/settings/backup`): `apps/app/src/components/controllerbackup/snapshots-list.tsx`
  renders the reason under `FAILED` rows (`ControllerSnapshotView.error` was already on the wire).
- Managed-DB backups: the restic catalog only ever lists successful snapshots, so the failure lived
  solely in the `swarmy.db.backup.lastRun` label. `lastError` is now threaded through
  `DbBackupScheduleView` / `DbBackupOverviewRow` (`packages/core/src/views.ts`,
  `packages/trpc/src/services/dbBackup.service.ts`) and a new "Last run" block in the cluster's
  Database backups panel shows status + reason
  (`apps/app/src/components/stacks/db-backup-last-run.tsx`, mounted from `db-backup-panel.tsx`).

**Status:** Fixed — pending a live re-check against a deliberately unreachable destination.
