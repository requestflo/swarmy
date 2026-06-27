# `.design/` — Living Design Ledger

This folder is the design source of truth for RequestFlo. It records the live route map, the named layout language, product-plan coverage, shared UI boundaries, theme rules, Tailwind conventions, and repeated UX patterns that future work must reuse.

## Purpose

- Stop new pages from inventing unnecessary layouts or near-duplicate components.
- Give the team one shared language for page shapes such as `List Layout`, `Inbox Layout`, `Request Detail Layout`, and `Builder Layout`.
- Show where shared primitives end and app-specific composites begin.
- Keep design decisions attached to live code, not to stale prototypes.

## Use Order

1. Check `routes.md` to find the live route, shell, and page component.
2. Pick a named layout from `layouts.md` before building or changing a page.
3. Check `product-coverage.md` to see whether the product-plan surface is covered, partial, or missing.
4. Check `components.md` and `ux-patterns.md` for reusable page parts and repeated interaction patterns.
5. Check `themes.md` and `tailwind.md` before adding new visual tokens or utility conventions.
6. Update the relevant `.design/*.md` files whenever live code changes.

## Files

| File | Tracks |
|------|--------|
| `components.md` | App-specific pages, page-local composites, shared UI boundaries, and canonical import paths |
| `routes.md` | Route tree, shell wiring, and the named layout used by each route |
| `product-coverage.md` | Product-plan surfaces mapped to routes, layouts, current coverage, and gaps |
| `hooks.md` | App, shared, and provider-scoped React hooks |
| `layouts.md` | Named layout language, route layouts, and layout guardrails |
| `flows.md` | User flows and the named layouts they move through |
| `themes.md` | Theme tokens, typography, custom utility classes, and dark mode behavior |
| `tailwind.md` | Tailwind entrypoints, scanning rules, layout sizing conventions, and utility guardrails |
| `ux-patterns.md` | Named recurring UX patterns such as headers, filter bars, stats strips, and action bars |

## Update Rules

- If a page fits an existing named layout, reuse it.
- If a truly new layout is needed, name it in `layouts.md` before it spreads to code.
- Document app-specific composites before promoting them into shared UI.
- Record temporary drift explicitly instead of silently copying it.
- Treat `.design/` as implementation guidance, not a mood board.
