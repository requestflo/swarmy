---
name: add-feature-slice
description: Build a new swarmy feature end-to-end across the stack (db model → agent protocol message → tRPC service+router → dashboard UI). Use when implementing a new capability that spans data, the agent, the API, and the dashboard — the recurring shape for swarmy roadmap epics.
---

# Add a feature slice

swarmy features cut vertically. Build in dependency order so types flow through.

## 1. Data (`packages/db`)
- Add/extend models in `prisma/schema.prisma`. Domain tables use `orgId` + an
  `org` relation (NOT `organizationId` — that's Better-Auth-only). Use enums,
  `Json`, `BigInt`, `@db.Timestamptz(3)` consistently with neighbours.
- `bun db:generate` then `bun db:push` (or `bun db:migrate`).

## 2. Agent protocol (`packages/core/src/protocol`) — only if the agent acts
- Add a controller→agent command message (a `z.object` with `commandId` +
  `timeoutMs?`) to the right file (`commands.ts` / `ingress.ts`) and include it in
  the `ControllerToAgentMessage` union in `messages.ts`.
- Add the `CommandName` + its protocol `type` to `COMMAND_PROTOCOL_TYPE` in
  `packages/trpc/src/hub/types.ts`.
- Implement it in the agent: handle the case in `apps/agent/src/executor.ts` via
  the `@swarmy/core/docker` wrapper; `run(...)` sends `commandResult`.
- Telemetry the agent PUSHES (no round-trip) goes through the gateway store +
  `AgentHub` snapshot/subscription methods instead.

## 3. Shared input/view types (`packages/core`)
- Form/API input schemas → `src/inputs.ts` (Zod, shared by RHF + tRPC `.input()`).
- Browser display shapes → `src/views.ts` (plain TS interfaces).

## 4. API (`packages/trpc`)
- Business logic in `src/services/<feature>.service.ts` taking `(ctx: OrgContext, args)`,
  filtering every query by `orgId`, throwing the helpers in `errors.ts`.
- Thin router in `src/routers/<feature>.ts` using `orgProcedure`/`adminProcedure`;
  mount it in `src/root.ts`.
- Mutations that need the agent call `ctx.hub.dispatch(nodeId, cmd, payload)`.

## 5. Dashboard (`apps/app`)
- Route under `src/routes/_authed/...`. Use `const trpc = useTRPC()` then
  `useQuery(trpc.x.queryOptions())` / `useMutation(trpc.x.mutationOptions())`.
  Live data: poll with `refetchInterval`. Build from `@swarmy/ui` components.

## 6. Verify
- `bun typecheck` (whole graph). For the app, `bun --filter @swarmy/app build`
  regenerates the route tree and validates bundling.
- Everything is org-scoped and should write an `auditLog` row for mutations.
