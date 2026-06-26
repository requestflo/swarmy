---
name: new-workspace
description: Scaffold a new swarmy monorepo workspace (a buildable lib in packages/* or a Bun/Vite app in apps/*) following the project's archetypes. Use when adding a new package or app to the swarmy monorepo so it wires into Turbo, TS, and workspace resolution correctly.
---

# Add a workspace

swarmy is a Bun + Turbo monorepo. Workspaces resolve to **`src` via package
`exports`** (no prebuild needed in dev); pure-TS lib `build` scripts are no-ops,
and apps build with Vite/`bun build`. Match one of three archetypes.

## Conventions (all workspaces)
- Name: `@swarmy/<name>`, `"private": true`, `"type": "module"`.
- `tsconfig.json` extends `../../tsconfig.base.json`.
- Cross-deps use `"workspace:*"`.
- `scripts.typecheck` = `tsc --noEmit`. Add to the root solution `tsconfig.json` `references`.

## Archetype A — buildable library (`packages/<name>`)
Model on `packages/ingress`.
- `exports`: `{ ".": { "types": "./src/index.ts", "import": "./src/index.ts" } }` (+ subpaths as needed).
- `scripts.build`: `"echo '@swarmy/<name> resolves to src'"` (no dist needed in-repo).
- `src/index.ts` barrel.

## Archetype B — Bun host/service (`apps/<name>`)
Model on `apps/api`.
- `scripts.dev`: `"bun run --watch src/index.ts"`, `build`: `"bun build src/index.ts --outdir dist --target bun"`.
- `tsconfig` `types: ["bun"]`.
- Pick a free port; add it to the root `predev` `kill-port` list.

## Archetype C — Vite SPA (`apps/<name>`)
Model on `apps/app` (TanStack Router) or `apps/web` (plain).
- deps: `react`/`react-dom` (pinned `19.2.4`), `@swarmy/ui`, etc.
- `vite.config.ts`: alias `@swarmy/*` → `../../packages/*/src` (regex for subpaths),
  `@` → `./src`; plugins `react()` + `tailwindcss()` (+ TanStack router plugin
  BEFORE `react()` if using file routes).
- `src/styles/globals.css`: `@import '@swarmy/ui/styles.css'; @source '../**/*.{ts,tsx}';`
- `index.html` with `<html class="dark">`.

## After scaffolding
1. `bun install` (links the workspace).
2. `bun --filter @swarmy/<name> typecheck`.
3. If it's an app, run its dev/build once to confirm it boots.
