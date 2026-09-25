---
name: scaffold-ingress-driver
description: Scaffold a new swarmy ingress driver (a new proxy or tunnel) in packages/ingress. Use when the user wants swarmy to support an additional ingress/reverse-proxy/tunnel option. Drivers are pure (render-only); the agent applies the RenderedConfig.
---

# Scaffold an ingress driver

swarmy's ingress is a pluggable registry. A driver turns an org's `IngressConfig`
(driver + domains + global options) into a `RenderedConfig` (files to write +
optional service labels + a reload command or admin-API call). The agent applies
that generic intent — drivers never touch a node directly.

## Steps

1. **Read the contracts first** so the new driver matches:
   - `packages/ingress/src/types.ts` — `IngressDriver` interface, `IngressConfig`, `DomainRoute`, `DriverDispatch`.
   - `packages/core/src/protocol/ingress.ts` — `RenderedConfig`, `RenderedFile`, `ServiceLabels`, and the optional `connector` block (tunnel/connector deployments), i.e. the wire types.
   - An existing driver: `packages/ingress/src/drivers/caddy.ts` (file strategy) or `cloudflared.ts` (tunnel/connector). (Traefik, nginx and HAProxy were removed in 2026-09 — check with the owner before adding a driver.)

2. **Pure renderer** — add `packages/ingress/src/render/<driver>.ts` (the
   convention: `caddyfile.ts`, `cloudflared.ts`)
   that builds the config string(s) from `IngressConfig` with no IO, and export
   it from `packages/ingress/src/index.ts`. Mirror `render/caddyfile.ts`.

3. **Driver** — add `packages/ingress/src/drivers/<driver>.ts` exporting a class
   implementing `IngressDriver` with `name`, `validate`, `render`, `apply`,
   `status`. `render` returns a `RenderedConfig`:
   - file-based proxies → `files: [{ path, contents, mode }]` + `reloadCommand`
     (or `adminApi`).
   - label-based proxies → `serviceLabels: [{ service, labels, removeLabelKeys }]`.
   - tunnels → a `connector` block (`render/connector.ts`
     `buildConnectorServiceSpec`, secrets passed by reference); swarmy makes
     no provider API calls (Cloudflare tunnels are pasted tokens).
   `apply` should `dispatch.resolveTargetNodes(...)` then `dispatch.sendToNode(...)`
   for each, exactly like `CaddyDriver.apply`.

4. **Register it** — in `packages/ingress/src/registry.ts` add
   `.register(new <Driver>())` to `defaultRegistry`, and export the class from
   `packages/ingress/src/index.ts`.

5. **Surface it** — add the name to:
   - the wire enum `IngressDriverName` in `packages/core/src/protocol/ingress.ts`,
   - the stored enum `IngressDriverEnum` in
     `packages/trpc/src/services/ingress-config.repo.ts` (UPPER_SNAKE; the
     config lives in swarm-kv, so no migration — but wire and stored names may
     differ, e.g. `cloudflared` ↔ `CLOUDFLARE_TUNNEL`),
   - `INGRESS_DRIVERS` + `INGRESS_DRIVER_LABELS` in `packages/core/src/types.ts`,
   - `packages/trpc/src/services/ingress.service.ts`: the `IngressDriverId`
     union, `DRIVER_TO_ENUM`, `driverLower()`; and `driverEnum`
     in `packages/trpc/src/routers/ingress.ts`,
   - the dashboard picker: `apps/app/src/components/ingress/driver-panel.tsx`,
     fed by `ALL_DRIVERS` / `DRIVER_LABELS` / `DRIVER_BLURB` / `IngressDriverId`
     in `components/ingress/driver-config.ts`; any driver-specific card goes in
     `routes/_authed/ingress.tsx` (as cloudflared does),
   - the demo resolver `apps/app/src/demo/resolvers/ingress.ts`.

6. **Verify** — a colocated golden render test (`render/<driver>.test.ts`, see
   `caddyfile.test.ts`), then `bun --filter @swarmy/ingress test` and
   `bun --filter @swarmy/ingress typecheck`.

## Notes
- Caddy is the new-org default (`DEFAULT_INGRESS` + the Prisma column
  default); keep `none` and every other driver first-class and selectable — a new
  driver never becomes the default, and an existing org's choice is never rewritten.
- If the driver needs a process in the swarm (e.g. its own container), document
  the placement and where it keeps shared state. Shared certs today live in
  each edge's own volume, replicated through swarmy object storage (bucket
  `swarmy-edge-certs`; `storage swarmy` wrapping certmagic-s3) — see
  `skill("geo-edge-routing")`; never render a credential into a config file.
- Tunnel drivers prefer the `connector` block over files + `reloadCommand`; the
  credentials-file path in `cloudflared.ts` is the fallback mode only.
