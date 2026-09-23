# Setting up swarmy's own S3 object storage (Garage) crashes with an unhandled error on the very first click, for every new org

**Status:** Fixed in code (2026-09) — pending live re-verification. See "Fix applied" below.
**Severity:** Critical — this is swarmy's flagship "no cloud account, no egress" S3 backup storage
feature (explicitly named in the governing directive: "the s three, the backups"), and it cannot be
turned on at all, for any org, ever, without hitting this crash first.

## Symptom

Platform → Backup destinations → "Replicated object store" panel → clicked "Configure Garage" (the
documented first step; the "Enable" button next to it is correctly disabled until this succeeds,
since it's gated on `cfg?.driver !== 'garage'` — see
`apps/app/src/components/backups/replicated-store-panel.tsx:109`). Result: a raw, unhandled JS error
toast appears —

```
null is not an object (evaluating 'row.memberNodeIds')
```

— and nothing else happens: `driver` stays `none`, the panel stays `off`, `members` stays `0`. The
mutation silently fails; there is no indication to the user of what went wrong or that this is
unrecoverable through the UI as-is.

## Root cause

`packages/trpc/src/services/replicatedStore.service.ts:184-219`, the `setDriver` mutation handler
that "Configure Garage" calls (`setDriver.mutate({ driver: 'garage' })`,
`replicated-store-panel.tsx:103`):

```js
export async function setDriver(ctx, input) {
  const existing = await load(ctx);
  const row = await db(ctx).upsert({
    where: { orgId: ctx.activeOrgId },
    create: { ... },
    update: {
      driver: input.driver.toUpperCase(),
      replicationFactor: input.replicationFactor ?? existing?.replicationFactor ?? DEFAULT_REPLICATION,
      region: input.region ?? existing?.region ?? 'swarmy',
      memberNodeIds: input.memberNodeIds ?? members(existing as ClusterRow),   // line 209
    },
  });
  ...
}
```

and `members()` at line 85-87:

```js
function members(row: ClusterRow): string[] {
  return Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [];
}
```

`members()` takes no null guard on `row` despite its call site passing `existing as ClusterRow` — a
type assertion, not a real narrowing, and `existing` is genuinely `null` for **any org that has never
configured object storage before** (`load()` at line 146-148 does `db(ctx).findUnique(...)`, which
returns `null` when no `StorageCluster` row exists yet — exactly this test's state, a freshly signed
up org that had never touched this feature).

The `update:` object is a plain JS object literal being *constructed* as an argument to
`db(ctx).upsert(...)` — its properties are evaluated eagerly, unconditionally, regardless of whether
Prisma's upsert ultimately executes the `create` or `update` branch against the database. So even
though this call was always going to take the `create` path (no row exists yet), the `update:`
object's `memberNodeIds` expression still evaluates first, calls `members(null)`, and throws before
`upsert()` is even invoked. The frontend never passes `memberNodeIds` in its mutation input
(`replicated-store-panel.tsx:103`: `{ driver: 'garage' }` only), so `input.memberNodeIds` is always
`undefined` and the crashing fallback always fires — this is not an edge case, it is the **only** path
through this function for a first-time setup, deterministically, every time.

## Why this matters

This blocks the entire "swarmy object storage" backup destination feature (the one-click, no-cloud-
account Garage S3 cluster the Backup destinations page advertises front and center: "Use swarmy
object storage — One click mints a dedicated bucket + key...") at its very first step, for every org
that has never used it before — which, for a fresh install, is every org. The only workaround
(untested, and out of scope per the "don't route around bugs" methodology) would be an org that
already has a `StorageCluster` row from some other path — not reachable through the product surface
for a new user.

## Suggested fix direction

- Make `members()` null-safe: `function members(row: ClusterRow | null): string[] { return
  Array.isArray(row?.memberNodeIds) ? (row.memberNodeIds as string[]) : []; }` — a one-line fix.
- More generally, review other call sites in this file that cast `existing`/`row` values with `as
  ClusterRow` instead of narrowing through an actual null check — `as` silences the type checker
  without adding runtime safety, which is exactly what let this through.
- Add a frontend error boundary or toast-level handling that turns raw `TypeError` messages like
  "null is not an object (evaluating '...')" into something a non-technical user could act on — this
  class of unhandled-exception-as-toast has now shown up at least once; worth checking whether the
  same crash-to-raw-toast pattern exists elsewhere.

## Not yet tested

Whether the same `members(existing as ClusterRow)` pattern (or similar unguarded-cast patterns)
appears elsewhere in this file's other mutations (`enable`, `disable`, layout/status updates) — worth
a follow-up grep before considering this file fully clear. Also not yet reached: the "Use swarmy
object storage" one-click flow itself, `Add destination` (external S3/node-path) as an independent
path, and whether the Garage cluster (once past this blocker) is even viable at all on this 1-node
test environment given its hardcoded `DEFAULT_REPLICATION = 3` (`replicatedStore.service.ts:34`) — a
single-node swarm may hit a second, separate blocker immediately after this one is fixed.

## Fix applied (2026-09)

- `packages/trpc/src/services/replicatedStore.service.ts`: `members()` accepts `null`/`undefined` and returns `[]`; the unsafe `existing as ClusterRow` cast is gone.
