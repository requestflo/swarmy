---
name: scaffold-ingress-driver
description: Scaffold a new swarmy ingress driver (e.g. nginx, haproxy, cloudflared) in packages/ingress. Use when the user wants swarmy to support an additional ingress/reverse-proxy/tunnel option. Drivers are pure (render-only); the agent applies the RenderedConfig.
---

# Scaffold an ingress driver

swarmy's ingress is a pluggable registry. A driver turns an org's `IngressConfig`
(driver + domains + global options) into a `RenderedConfig` (files to write +
optional service labels + a reload command or admin-API call). The agent applies
that generic intent — drivers never touch a node directly.

## Steps

1. **Read the contracts first** so the new driver matches:
   - `packages/ingress/src/types.ts` — `IngressDriver` interface, `IngressConfig`, `DomainRoute`.
   - `packages/core/src/protocol/ingress.ts` — `RenderedConfig`, `RenderedFile`, `ServiceLabels` (the wire types).
   - An existing driver: `packages/ingress/src/drivers/caddy.ts` (file strategy) or `traefik.ts` (label strategy).

2. **Pure renderer** — add `packages/ingress/src/render/<driver>-conf.ts` with a
   function that builds the config string(s) from `IngressConfig` (no IO). Mirror
   `render/caddyfile.ts`.

3. **Driver** — add `packages/ingress/src/drivers/<driver>.ts` exporting a class
   implementing `IngressDriver` with `name`, `validate`, `render`, `apply`,
   `status`. `render` returns a `RenderedConfig`:
   - file-based proxies → `files: [{ path, contents, mode }]` + `reloadCommand`
     (or `adminApi`).
   - label-based proxies → `serviceLabels: [{ service, labels, removeLabelKeys }]`.
   `apply` should `dispatch.resolveTargetNodes(...)` then `dispatch.sendToNode(...)`
   for each, exactly like `CaddyDriver.apply`.

4. **Register it** — in `packages/ingress/src/registry.ts` add
   `.register(new <Driver>())` to `defaultRegistry`, and export the class from
   `packages/ingress/src/index.ts`.

5. **Surface it** — add the name to:
   - the wire enum `IngressDriverName` in `packages/core/src/protocol/ingress.ts`,
   - the DB enum `IngressDriver` in `packages/db/prisma/schema.prisma` (then `bun db:generate`),
   - `INGRESS_DRIVERS` + `INGRESS_DRIVER_LABELS` in `packages/core/src/types.ts`,
   - `listDrivers()` / `driverEnum` in `packages/trpc/src/services/ingress.service.ts` and `routers/ingress.ts`,
   - the driver `<Select>` in `apps/app/src/routes/_authed/ingress.tsx`.

6. **Verify** — `bun --filter @swarmy/ingress typecheck` and add a render unit test.

## Notes
- Keep `none` first-class: never make a new driver the forced default.
- If the driver needs a process in the swarm (e.g. its own container), document
  the placement and whether it stores shared state (e.g. certs in Redis).
- For tunnel-style drivers (cloudflared/ngrok), `render` may emit credentials
  files + a `reloadCommand` that (re)starts the tunnel; no public ports needed.
