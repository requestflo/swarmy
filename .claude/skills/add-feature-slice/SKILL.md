---
name: add-feature-slice
description: Build a new swarmy feature end-to-end across the stack (db model → agent protocol message → tRPC service+router → dashboard UI). Use when implementing a new capability that spans data, the agent, the API, and the dashboard — the recurring shape for swarmy roadmap epics.
---

# Add a feature slice

swarmy features cut vertically. Build in dependency order so types flow through.
Each layer has an owning skill with the invariants — this one is the map.

## 1. Data — Docker first, the embedded store only if it must (`packages/db`)
- **First run `skill("docker-native-storage")`.** Anything describing how a
  service/stack/node should behave lives on the Docker object (label / config /
  secret), not in a new Prisma model. The controller's embedded SQLite store
  (`control.db`) is for swarmy's own identity, access, audit, and queryable
  history.
- If it does belong in the DB: the schema is multi-file —
  `packages/db/prisma/schema/<domain>.prisma` (`provider = "sqlite"`). Domain
  tables use `orgId` + an `org` relation (NOT `organizationId` — that's
  Better-Auth-only). Hot time-series goes in `telemetry.db`
  (`prisma/telemetry/schema.prisma`, no FKs into `control.db`).
- **Keep types SQLite-portable.** `enum`, `Json`, `DateTime` and `BigInt` fields
  are fine. No `@db.*` annotations. No scalar lists (`String[]`) — use `Json`.
  Autoincrement ids are `Int @id @default(autoincrement())` (the rowid alias),
  never `BigInt`. Raw SQL must be SQLite SQL (`strftime`, not `date_trunc`).
- **Ship a migration.** `bun run db:migration <name>` (add `--telemetry` for
  `telemetry.db`) writes the next folder under `packages/db/prisma/migrations/`
  from the schema diff; never hand-write it. The controller applies it on boot
  (`ensureSchema`). `bun run db:check` is the CI gate and fails on drift. There
  is no `db:push`: `prisma db push` breaks on SQLite `Json` defaults.
- Tests that need a DB use `createTestDb()` from `@swarmy/db` (a fresh migrated
  temp-dir store; call `close()`).

## 2. Agent protocol (`packages/core/src/protocol`) — only if the agent acts
- Follow the "Adding a command" recipe in `skill("agent-handlers")`: a Zod
  message in `protocol/<domain>.ts` added to the `ControllerToAgentMessage`
  union, a `CommandName` in `COMMAND_PROTOCOL_TYPE`
  (`packages/trpc/src/hub/types.ts`), a `case` in `apps/agent/src/executor.ts`
  calling a handler in `apps/agent/src/handlers/`, plus its round-trip parse
  test (`skill("testing-conventions")`).
- Reads are not commands: telemetry the agent PUSHES goes through the gateway
  store + hub snapshots instead.
- If something must keep converging (labels → Docker), that's a worker:
  `skill("reconcile-workers")`.
- Don't add a command for one-shot tools (trivy, cosign, wal-g, drills) — use
  `container.runOnce`; in-container CLIs (`psql`, `redis-cli`) use `exec`. Any
  credential stored in a DB row goes through `encryptSecret`
  (`@swarmy/core/crypto`) and is never returned to a client.

## 3. Shared input/view types (`packages/core`)
- Form/API input schemas → `src/inputs.ts` (Zod, shared by RHF + tRPC `.input()`).
- Browser display shapes → `src/views.ts` (plain TS interfaces).

## 4. API (`packages/trpc`)
- Business logic in `src/services/<feature>.service.ts` taking `(ctx: OrgContext, args)`,
  filtering every query by `orgId`, throwing the helpers in `errors.ts`.
- Thin router in `src/routers/<feature>.ts` using `orgProcedure`/`adminProcedure`;
  mount it in `src/root.ts`.
- Mutations that need the agent call `ctx.hub.dispatch(nodeId, cmd, payload)`.
- Every mutation writes audit through the single writer `writeAudit`
  (`services/audit.service.ts`); policy-gated ones use `abacProcedure`
  (`skill("auth-abac")`). If it should be public API too, add the REST route
  over the same service (`skill("rest-api-surface")`).

## 5. Dashboard (`apps/app`)
- Route under `src/routes/_authed/...`. Use `const trpc = useTRPC()` then
  `useQuery(trpc.x.queryOptions())` / `useMutation(trpc.x.mutationOptions())`.
  Live data: poll with `refetchInterval`. Build from `@swarmy/ui` components
  (`skill("react-components")`, `skill("hot-signal-design")`). Add a demo
  resolver in `apps/app/src/demo/resolvers/*` for every new query so `?demo=1`
  keeps working.

## 6. Verify
- `bun typecheck` (whole graph) and the package tests. For the app,
  `bun --filter @swarmy/app build` regenerates the route tree and validates
  bundling.
- Everything is org-scoped; every mutation is audited.
