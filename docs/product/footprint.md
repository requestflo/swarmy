# Controller memory footprint

Swarmy should run on a 1 GB VPS. This note records where the controller's memory
goes, what we changed, and what's left, so later work starts from measurements
instead of guesses.

## Current store: embedded SQLite

The controller's store is now embedded SQLite (`bun:sqlite`, WAL) in two files,
`control.db` and `telemetry.db`, opened once per process through the in-repo
driver adapter (`packages/db/src/bun-sqlite-adapter.ts`). It replaced PGlite on
2026-09-24. There is no WASM Postgres, no initdb and no template: SQLite costs a
few MB, so the first-boot peak and the two-instance problem described below are
gone.

- TODO: controller RSS on a 1 GB VPS with SQLite: to be measured.

Everything from "How it was measured" through "Tried and rejected" is
**historical**: it was measured on the PGlite store. The JS findings (module
graph, Prisma query compiler, `MIMALLOC_PURGE_DELAY=0`) still apply.

## Historical (PGlite): how it was measured

- The `swarmy-controller` image (bun 1.3.14, linux/arm64). Changed sources were
  bind-mounted over `/app/packages/db/src`. Embedded PGlite store,
  `SWARMY_BOOTSTRAP=1`, one org, no nodes attached, 35 s per run.
- **cgroup** is `memory.current` / `memory.peak`, which is what the OOM killer
  counts. `anon` is the anonymous part of `memory.stat`. A `--preload` probe also
  logged `process.memoryUsage()` and `bun:jsc` `heapStats()`, and `/proc/1/smaps`
  gave the per-mapping breakdown.
- **First boot** starts with an empty data dir (initdb + migrations + seed).
  **Restart** reuses the same data dir.

## Historical (PGlite): results

| Scenario | cgroup peak | cgroup steady | anon steady |
|---|---|---|---|
| Before, first boot | 1333–1365 MiB | 522–611 MiB | 461–468 MiB |
| Before, restart | 658–692 MiB | 443 MiB | 436 MiB |
| After, first boot | **545 MiB** | **366 MiB** | 309 MiB |
| After, restart | **324 MiB** | **284 MiB** | 278 MiB |

The first-boot peak was the 1 GB OOM. It is now about 2.5× lower, and a 1 GB
droplet boots without needing swap.

## Historical (PGlite): where the memory went

1. **PGlite's initdb (first boot only): about 0.9–1 GiB peak on its own.** On an
   empty data dir PGlite starts a nested in-memory WASM Postgres and the initdb
   WASM, then copies the data dir through a tar round-trip. Measured alone, a
   fresh `PGlite.create({dataDir})` peaks at 890–1016 MiB. The instance that ran
   initdb also kept about 180 MiB of those heaps reachable for as long as it
   lived.
2. **Two PGlite instances per boot.** `ensureSchema(buildAdapter())` and the app's
   `PrismaClient` each started their own WASM Postgres on the same data dir. Each
   one is at least 128 MiB of WASM memory, the minimum `pglite.wasm` declares
   (`initialMemory` cannot go lower).
3. **Server-sized Postgres settings inside the WASM heap.** initdb wrote
   `shared_buffers=128MB`, `max_connections=100` and `maintenance_work_mem=64MB`.
   A WASM heap never shrinks, so anything touched once stays resident.
4. **What's left is mostly JS.** Importing the full module graph adds about
   160 MiB RSS. Of that, `@swarmy/db` (the Prisma client, including its 4.9 MB
   base64 query-compiler WASM) is about 48 MiB, `@swarmy/auth` (better-auth and
   kysely) about 40 MiB, and trpc, routers and workers the rest. The heap holds
   about 535k objects and 187k functions. The bun binary's mapped text is about
   39 MiB. PGlite's WASM memory is now only about 27 MiB resident out of a
   143 MiB mapping.

## Historical (PGlite): changes

The PGlite items below (`pglite-adapter.ts`, the template, `SWARMY_PGLITE_*`)
were deleted with the SQLite switch. `MIMALLOC_PURGE_DELAY=0` stays.

- `packages/db/src/pglite-adapter.ts`
  - `LITE_POSTGRES_SETTINGS`: `shared_buffers=16MB`, `maintenance_work_mem=16MB`
    and `max_connections=10`. They are passed as `-c` start params on top of
    `PGlite.defaultStartParams`, and on a fresh cluster initdb also bakes them
    into `postgresql.conf` via `--set`. The control-plane DB is a few MB and
    PGlite is single-user.
  - `keepOpen`: disposing one adapter no longer closes the instance, so several
    `connect()` calls share it.
  - Fresh data dir: seed it from an image-baked template (`templateTarball`) when
    one is present. Otherwise run initdb in a throwaway instance that is closed
    and garbage-collected before the long-lived instance opens.
  - `buildPgliteTemplate()` builds that template.
- `packages/db/src/client.ts`: `buildAdapter()` returns one shared PGlite factory
  per data dir for process-env callers, so boot-time `ensureSchema`, the restore
  CLI and `PrismaClient` share a single instance. It also reads the
  `SWARMY_PGLITE_TEMPLATE` path and the optional `SWARMY_PGLITE_SHARED_BUFFERS`
  override (for example `64MB` on a larger node).
- `packages/db/scripts/pglite-template.ts` and `apps/api/Dockerfile`: the image
  builds `/app/pglite-template.tar.gz` (about 4.5 MB) with the same PGlite build
  it runs, and sets `SWARMY_PGLITE_TEMPLATE`. Nodes never run initdb, and loading
  the template peaks at about 0.4 GiB instead of about 1 GiB. The only thing
  installs share is the cluster system identifier, and nothing reads it in
  single-user embedded mode. Backups are logical dumps.
- `apps/api/Dockerfile`: `MIMALLOC_PURGE_DELAY=0`. Freed allocator pages go back
  to the OS immediately, which saves about 25–30 MiB steady and about 45–70 MiB
  of peak.

## Historical (PGlite): tried and rejected

| Option | Effect | Verdict |
|---|---|---|
| `bun --smol` | ±2 MiB steady, peak +15 MiB | No gain. The memory isn't JS heap. |
| Lower PGlite `initialMemory` | LinkError | `pglite.wasm` declares a 128 MiB minimum |
| `BUN_JSC_useOMGJIT=false` | −2 MiB | Noise |
| No WASM JIT (`useBBQJIT/useOMGJIT=false`) | −27 MiB | Rejected: Postgres would run interpreted |
| Capping in-memory caches | n/a | Nothing unbounded. Gateway store holds latest snapshots per node, build-log bus is capped at 256×2000 lines, image/status/AI caches are capped or TTL'd. JS heap is about 60 MiB. |
| SPA from memory | n/a | Already streamed from disk (`serveStatic` / `Bun.file`) |

## What's left (to get under 250 MiB steady)

- **Pre-bundle the controller** (`bun build --target bun --minify`, with Prisma
  as an external). The prototype was measured on the PGlite store. In a prototype this cut about 25–40 MiB (anon
  303 → 263 MiB). It first needs the `import.meta.url`-relative paths fixed:
  `ensure-schema.ts` migrationsDir and `agent-release.service.ts` repoRoot.
- **Lazy-load feature surfaces** that a lite install with a few stacks never
  touches (managed data, search, vector, storage, AI gateway). Today
  the tRPC router and the worker index import every service at boot.
- **Avoid a second copy of the Prisma query compiler.** It is about 48 MiB with
  its base64 source. Worth revisiting when Prisma ships a leaner runtime for
  driver adapters.
