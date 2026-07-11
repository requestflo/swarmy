---
name: react-components
description: React component conventions, file decomposition rules, hooks, and data fetching patterns for swarmy's apps/app (Vite SPA, React 19, TanStack Router, tRPC v11 + @trpc/tanstack-react-query). Load when writing components, hooks, or data access in apps/app.
metadata:
  auto_invoke:
    - component
    - React
    - hook
    - tsx
    - data fetching
---

# React Components (swarmy)

## When to use me

Load when working on React components (`.tsx` in `apps/app/src`), custom hooks
(`use-*.ts`), or tRPC v11 + TanStack Query data access. Pair with
`skill("hot-signal-design")` for the visual system.

## Before you build: check what exists

1. Scan `apps/app/src/components/` for existing app components/hooks.
2. Scan `packages/ui/src/components/` for shared primitives (`skill("design-reference")`).
3. Reuse or extend before creating new.

## File size limits (hard rules)

| File | Hard limit | When exceeded |
|---|---|---|
| Route / page component | **150 lines** | split into sub-components |
| Feature component | **150 lines** | extract sections into files |
| Form component | **120 lines** | extract field groups |
| Custom hook (`use-*.ts`) | **80 lines** | split by concern |

## Decomposition

Every distinct UI concern lives in its own file. **Never inline forms, dialogs,
or filter bars in a route component.** A route file orchestrates; sub-components
live in `apps/app/src/components/<feature>/` or `src/features/<feature>/`.

| UI element | File pattern |
|---|---|
| Page orchestrator | `<page>-page.tsx` |
| Filter/search bar | `<page>-filters.tsx` |
| List / list row | `<page>-list.tsx` / `<page>-row.tsx` |
| Detail / panel | `<page>-detail.tsx` |
| Dialog / Sheet | `<action>-<entity>-dialog.tsx` |
| Form | `<entity>-form.tsx` |
| Data hook | `use-<concern>.ts` |

## Data fetching — tRPC v11 + @trpc/tanstack-react-query

swarmy uses the **`useTRPC()` + `queryOptions`/`mutationOptions`** integration
(set up in `apps/app/src/integrations/trpc.tsx`, provided in
`components/providers.tsx`). This is swarmy's canonical pattern — use it directly
in components; do **not** hand-roll a vanilla-client `data/hooks.ts` layer.

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@/integrations/trpc'

export function NodesList(): React.JSX.Element {
  const trpc = useTRPC()
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 })
  // ...
}

export function ScaleButton({ id }: { id: string }): React.JSX.Element {
  const trpc = useTRPC()
  const qc = useQueryClient()
  const scale = useMutation(
    trpc.services.scale.mutationOptions({ onSuccess: () => qc.invalidateQueries() }),
  )
  // ...
}
```

- **Live data = polling** via `refetchInterval` (2s for stats, 3–5s for lists).
  Subscription routers exist server-side for a future SSE swap.
- Invalidate by calling `qc.invalidateQueries()` (or scoped) in mutation `onSuccess`.
- The `AppRouter` type is imported as a **type only** from `@swarmy/trpc`; the app
  never bundles server code.

## Import conventions

```tsx
// 1. external libs
import { useQuery } from '@tanstack/react-query'
import { ServerIcon } from 'lucide-react'
// 2. workspace packages
import { Button, Card, cn } from '@swarmy/ui'
import { type NodeSummary, SERVICE_STATUS_TONE } from '@swarmy/core'
// 3. app-local (the `@/` alias → apps/app/src)
import { useTRPC } from '@/integrations/trpc'
import { PageHeader } from '@/components/page-header'
import { NodeRow } from './node-row'
```

## Rules

### Do
- **Named exports**, **explicit return types** (`React.JSX.Element`), **`interface`** for props.
- **`import type`** for type-only imports (verbatimModuleSyntax is on).
- **`cn()`** for conditional Tailwind; tokens only (no raw palette).
- Handle **loading / error / empty / success** explicitly; every empty state sells the next action.
- Mobile-first responsive; the layout swap is `lg` (1024px) via `useBelowLg()`.

### Do not
- No `"use client"` / `"use server"` (Vite SPA), no Next.js APIs.
- No `any` — use `unknown`. No `React.FC` — plain function declarations.
- Don't import from `@/components/ui/*` — use `@swarmy/ui` real exports.
- Don't inline forms/dialogs/filter bars in route files.

## Validation

```bash
bun --filter @swarmy/app typecheck
bun --filter @swarmy/app build   # also regenerates the TanStack route tree
```
