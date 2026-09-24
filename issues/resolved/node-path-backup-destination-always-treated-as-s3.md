# "Node path" backup destinations are completely non-functional — a case-mismatch bug silently treats every one of them as an S3 destination

**Status:** Fixed in code (2026-09) — pending live re-verification. See "Fix applied" below.
**Severity:** Critical — this is one of only two backup-destination kinds swarmy offers (the
other being external S3-compatible, confirmed working — row 12 of
the readiness sweep log (`plans/readiness-sweep-2026-07.md`, in git history)), and in a single-node local/on-prem deployment with no cloud
account, "node path" is the *only* destination kind that could produce a genuinely successful
backup without external dependencies. It cannot work at all, for any org, ever.

## Symptom

Platform → Backup destinations → "Add destination" → Kind = "Node path", Base path
`/srv/backups`, Prefix `swarmy-test`. Submission succeeds ("Destination added" toast, new list
entry) — but the list entry's kind badge reads **"S3"**, not "Node path", which was the first
sign something was wrong.

Triggered an ad-hoc backup against this destination (stack `littleworld`, volume
`littleworld_main-cache-data`, via "Back up now"). The run went `RUNNING` → **`FAILED`** within a
few seconds. Direct node inspection confirmed `/srv/backups` was never created on the node's
filesystem at all — nothing was ever written to disk.

Querying the `snapshot` table directly (dashboard UI has no way to show this — see
[[backup-failure-reason-captured-but-never-shown]]) surfaced the real restic error:

```
Fatal: unable to open config file: Stat: Get "https://srv/backups/?location=": dial tcp: lookup srv on 192.168.5.2:53: no such host
Is there a repository at the following location?
s3://srv/backups/swarmy-test
```

Restic is trying to treat `/srv/backups` as an S3 bucket path and DNS-resolve the string `srv`
as a hostname — for a destination the user explicitly configured as "Node path," a local
filesystem repo with no network or DNS involvement at all.

## Root cause

`packages/trpc/src/services/backups.service.ts:117-125`, `repoUrl()`, the function that turns a
stored destination row into the actual restic repository string:

```js
function repoUrl(row: TargetRow): string {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  if (row.kind === 'node') {                                            // line 119
    // local path on the node: bucket carries the base dir.
    return `${row.bucket.replace(/\/+$/, '')}${prefix}`;
  }
  const endpoint = (row.endpoint ?? '').replace(/\/+$/, '');
  return `s3:${endpoint}/${row.bucket}${prefix}`;
}
```

This checks `row.kind === 'node'` — a **lowercase** string comparison. But the Prisma schema
defines `kind` as an uppercase enum (`packages/db/prisma/schema/backups.prisma:19`:
`kind BackupTargetKind @default(S3)`), and `addTarget` — the mutation "Add destination" actually
calls — stores it uppercase:

`packages/trpc/src/services/backups.service.ts:298`:
```js
kind: input.kind === 'node' ? 'NODE' : 'S3',
```

So every row ever written to the database has `kind` = the literal string `'NODE'` or `'S3'`
(uppercase), never lowercase `'node'`. `repoUrl()`'s `row.kind === 'node'` check can therefore
**never be true for any real row** — it always falls through to the S3 branch, treating the
node-path destination's "Base path" value as if it were an S3 bucket name with no endpoint:
`s3:${''}/${row.bucket}${prefix}` — and since `row.bucket` itself is `/srv/backups` (a leading
slash from the form's own "Base path" placeholder convention, `/srv/backups`), the result is
`s3://srv/backups/swarmy-test` — restic parses `srv` as the S3 endpoint hostname and tries to
resolve it via DNS, which fails.

The exact same pattern (`row.kind === 'node' ? 'node' : 's3'`) also appears at lines 84 and 130
in the same file — this is what makes `toView()` report `kind: 's3'` for every node-path
destination too, which is why the destinations list UI shows the badge **"S3"** for a
"Node path" entry — the frontend is being told, honestly, exactly what the (bugged) backend
believes the kind to be. Both the wrong UI badge and the backup failure are two symptoms of this
single root cause.

## Why this matters

This isn't a rare edge case or misconfiguration — it is the **only** code path a "Node path"
destination can ever take, for every org, deterministically, every time. Combined with the
already-documented [[replicated-object-store-crashes-on-first-configure]] (swarmy's own
self-hosted Garage S3 store crashes on first configure), this means, right now, **the only
backup destination kind that actually works end-to-end in swarmy is an external S3-compatible
bucket** — a real cloud account is required to get a single successful backup, which directly
contradicts the "no cloud account, no egress" pitch on swarmy's own Backup destinations page and
undermines local/on-prem/single-node deployments (like this test environment) from ever
producing a genuinely successful backup at all.

## Suggested fix direction

- Fix the three case-mismatched comparisons (`backups.service.ts:84`, `:119`, `:130`) to compare
  against the actual stored enum value — either compare `row.kind === 'NODE'` (matching the
  Prisma enum casing), or normalize once at the boundary (e.g. `row.kind.toLowerCase()`) and
  compare consistently everywhere. Given the same typo-prone pattern is duplicated three times in
  one file, consider a single `isNodeKind(row)` helper instead.
- Add a regression test asserting `repoUrl()` produces a bare filesystem path (no `s3:` prefix)
  for a `kind: 'NODE'` row — this class of bug (a literal string comparison silently never
  matching) is exactly what unit tests exist to catch and evidently wasn't covered.
- Once fixed, this destination kind will likely still need the bind-mount question resolved
  separately — confirm whether `apps/agent/src/handlers/backup.ts`'s sidecar `HostConfig.Binds`
  needs a host-path bind added for `kind: 'node'` repos so the restic container can actually
  reach `/srv/backups` on the node's real disk (the sidecar is otherwise only ever bound to the
  volume being backed up, per `apps/agent/src/handlers/backup.ts:267`) — not yet confirmed live
  since this bug blocks reaching that code path at all.

## Not yet tested

Whether fixing the case-mismatch alone is sufficient, or whether the bind-mount gap noted above
is a second, independent blocker once the first is fixed. Restore-from-snapshot testing (blocked
entirely — no successful backup has yet been produced against any destination kind in this
sweep).

## Fix applied (2026-09)

- `packages/trpc/src/services/backups.service.ts`: new `isNodeTarget()` normalises the Prisma enum case; used by `toView`, `repoUrl`, `toResticRepo`. Regression tests in `backups.service.test.ts`.
- Second, latent bug found while fixing: the agent's restic sidecar never bind-mounted a node-path repo, so even a correctly-routed node repo would have been written inside the throwaway container and lost. `apps/agent/src/handlers/backup.ts` now adds `repoBinds(repo)` (host path bound at the same path) to every restic sidecar. Tested in `backup.test.ts`.
