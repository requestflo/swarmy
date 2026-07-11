---
name: design-reference
description: Reference for the shared @swarmy/ui package and the apps/web marketing site — import conventions, UI placement rules, and how Hot Signal design tokens are shared. Product (apps/app) UI authority lives in hot-signal-design.
---

## When to use me

Load this skill when:
- Working in the shared **`@swarmy/ui`** package (adding/using primitives, import paths, package boundaries).
- Building or editing the **`apps/web` marketing site** (Vite, port 4000).

> **For `apps/app` product UI, load `skill("hot-signal-design")`** — the source of
> truth for the product experience (tokens, classes, shell, copy).

## One design language: "Hot Signal"

A single design language across the repo: **Hot Signal** — hot coral on deep navy
ink, warm paper, Bricolage Grotesque headlines, pill buttons, status-token cards.

Unlike a per-app token split, swarmy centralises Hot Signal tokens + utility
classes in **`@swarmy/ui/src/styles.css`**, exported as `@swarmy/ui/styles.css`.
Both apps import it:
- `apps/app/src/styles/globals.css` → `@import '@swarmy/ui/styles.css';` + `@source` + fonts.
- `apps/web/src/styles.css` → `@import '@swarmy/ui/styles.css';` + `@source`.

`@swarmy/ui` primitives use token names (`bg-primary`, `border-border`,
`text-status-online`, …) that resolve at render time, so they inherit Hot Signal
automatically. Never reintroduce the old zinc/emerald base or `hsl(var(--token))`
(invalid CSS — tokens are raw `oklch`; use `var(--token)` or
`color-mix(in oklab, var(--token) N%, transparent)` for alpha).

## Shared `@swarmy/ui` package

shadcn-pattern primitives + swarmy composites. Import from the real export paths
in `packages/ui/package.json`:

```tsx
// CORRECT
import { Button, Card, StatusBadge, cn } from '@swarmy/ui'        // barrel
import { Button } from '@swarmy/ui/components/button'             // deep import
import { cn } from '@swarmy/ui/lib/utils'

// WRONG
import { Button } from '@/components/ui/button'                   // ❌
import { Button } from '@swarmy/ui/components/ui/button'          // ❌ (no /ui/ nesting in swarmy)
```

Export roots: `@swarmy/ui` (barrel), `@swarmy/ui/components/*`, `@swarmy/ui/lib/*`,
`@swarmy/ui/styles.css`. Composites already present: `status-badge`, `sparkline`,
`metric-card`, `copy-button`, `empty-state` (plus the shadcn primitives).

### UI placement guide
- **Shared primitive / generic building block** → `packages/ui`.
- **App-specific composed feature UI** → app-local (`apps/app/src/components/…`).
- **Domain copy, routing, or API calls** → app-local, never the package.

### Package rules
- Keep components generic — no swarmy route/business logic baked in.
- Small composable props; accessible defaults; semantic markup.
- Use `cva` / `clsx` / `tailwind-merge` (via `cn`) consistently.
- Never import app-local modules into the package.
- Status tokens (`--status-online|progress|warning|offline|idle`) as Tailwind
  colors (`text-status-online`, `bg-status-warning/12`) — never raw palette colors.

## apps/web marketing site

`apps/web` (port **4000**, Vite + React) is a thin landing site: hero, features,
CTA, footer, using Hot Signal tokens + framer-motion reveals. It mirrors the
product's tokens so the jump to the dashboard is zero-surprise. Not the product
app; no `/app` shell.

## Historical reference (read-only, dated)

`.design/` holds RequestFlo-origin ledgers (`themes.md` describes a superseded
iris system) — background only, NOT authoritative. See `.design/_ABOUT.md`. When
it conflicts with this skill or `hot-signal-design`, the skills win.
