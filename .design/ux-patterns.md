# UX Patterns Ledger

## Named Page Parts

| Pattern | Used In | What Stays Consistent |
|---------|---------|-----------------------|
| `Page Header` | All internal app pages | Title on the left, one-line support copy when needed, primary CTA on the right. **Use `PageHeader` component** — `apps/web/src/components/common/page-header.tsx`. Single unified style: `text-2xl font-semibold`, `px-8 pt-6 pb-5 border-b`. No variants. |
| `Page Content` | `ActionsPage`, `ConnectorsPage`, `TeamPage`, `BillingPage` | Scrollable body wrapper with consistent padding and max-width. **Use `PageContent` component** — `apps/web/src/components/common/page-content.tsx`. Props: `maxWidth?: "4xl" \| "5xl" \| "6xl" \| "full"` (default `"6xl"`). |
| `Stats Strip` | `ActionsPage`, `TeamPage`, `ConnectorsPage` | 4-column KPI card grid. **Use `StatsStrip` component** — `apps/web/src/components/common/stats-strip.tsx`. Props: `stats: StatItem[]`, `cols?: number`. Each stat: `label`, `value` (string), `icon` (ReactNode), `iconBg` (Tailwind class string e.g. `"bg-success/10"`). |
| `Search Input` | `RequestsPage`, `InboxPage`, `TeamPage`, `ActionsPage` | Icon-prefixed search field. **Use `SearchInput` component** — `apps/web/src/components/common/search-input.tsx`. Props: `placeholder?`, `value`, `onChange(value: string)`, `className?`, `inputClassName?`. Standard size: `h-9 pl-9 text-sm`. |
| `Filter Pills` | `RequestsPage`, `ConnectorsPage` | Small toggle pill buttons for category/status filtering. **Use `FilterPills` component** — `apps/web/src/components/common/filter-pills.tsx`. Props: `options: {id, label}[]`, `value`, `onChange`. Active state: `bg-foreground text-background font-medium`. |
| `Section Label` | `InboxDetailPane`, `CreateRequestForm` | Uppercase eyebrow label for grouping content. **Use `SectionLabel` component** — `apps/web/src/components/common/section-label.tsx`. Props: `as?: "div" \| "span" \| "h3" \| "p" \| "th"`, `className?`. Style: `text-xs font-semibold uppercase tracking-wider text-muted-foreground`. |
| `Filter Bar` | `RequestsPage`, `TeamPage`, `InboxPage` | Search and filters sit together directly under a header or card header. Compose `FilterPills` + `SearchInput`. |
| `Section Card` | `BillingPage`, `SettingsPage`, `TeamPage`, `ActionsPage` | Bordered block, optional muted header strip, consistent spacing inside |
| `Worklist Row` | `InboxPage`, `RequestsPage`, `ActionsPage` | Dense row, hover affordance, hidden secondary actions until hover or active |
| `Tab Strip` | `RequestDetailPage`, `SettingsPage`, `TeamPage`, `ActionsPage`, `InboxPage` detail pane | Local page navigation sits directly under the page or pane header |
| `Utility Rail` | `RequestDetailPage` | Narrow right-side context for quick actions, metrics, or history |
| `Preview Rail` | `CreateRequestPage` | Right-side live preview of what the recipient will see |
| `Fixed Action Bar` | `InboxPage`, `CreateRequestPage`, `RequestsPage` footer | Final or sticky action row with summary on one side and key actions on the other |

## Empty States

Every list, grid, and search result must have an empty state.

| Pattern | Location | Notes |
|---------|----------|-------|
| Generic Empty | `packages/ui/src/components/ui/empty.tsx` | Icon + title + description + optional action |
| Inline page empty state | `RequestsPage`, `ActionsPage`, `InboxPage` | Use when the surrounding layout should stay visible while only the collection empties |
| EmptyState hero | Requests, Actions, Inbox (when empty) | Use `variant="hero" aurora` for first-run/new-user empty states. Use `variant="hero"` (no aurora) for filtered-no-results states on config pages. |

## Loading and Validation Feedback

| Pattern | Location | Notes |
|---------|----------|-------|
| Skeleton loading | Prefer shared `skeleton` primitive | Preserve layout shape during load |
| Inline form errors | Form field message area | Use specific field text, not generic failure copy |
| Root submission error | Auth and responder banners | Top-of-form error summary for submission failures |
| Review warning block | `InboxPage`, `RequestDetailPage` | Use bordered warning or destructive block for "why review" or "needs attention" |
| Upload and validation status | `FloItemCard`, inbox detail, request detail actions | Show ready, checking, passed, failed, and retry states clearly |

## Interaction Patterns

| Pattern | Description |
|---------|-------------|
| `Collapsible Sidebar` | App shell sidebar collapses to icon mode; topbar keeps the page context reachable |
| `Pill Filter Tabs` | Small filter buttons; active state is dark/filled or strong highlighted state |
| `Dense Data Row` | Row uses strong title, lighter metadata, and secondary actions hidden until hover |
| `Action Reveal on Hover` | Secondary row actions fade in on hover rather than taking constant visual weight |
| `Upload Zone` | Drag-and-drop zone with clear ready, uploading, and error states |
| `Touch Targets` | Interactive elements should stay at or above `min-h-[44px]` when used in mobile or public flows |

## Do Not Spread

- Do not copy one-off tab styling into a new page if an existing named layout already defines it.
- Do not spread legacy `panel*` or `data-table` class names until they are formally documented as shared utilities.
- Do not create a second header, filter, or stats pattern for a page that already fits an existing named layout.
- **Do not inline** `relative > Search icon + Input pl-9` — use `SearchInput`.
- **Do not inline** `grid gap-4 md:grid-cols-4 > Card > CardContent` stat grids — use `StatsStrip`.
- **Do not inline** `flex-1 overflow-auto p-6 > mx-auto max-w-* space-y-6` — use `PageContent`.
- **Do not inline** `text-xs font-semibold uppercase tracking-wider text-muted-foreground` — use `SectionLabel`.
- **Do not inline** pill filter button loops — use `FilterPills`.

## Common Components (`apps/web/src/components/common/`)

These are the shared building blocks for all internal app pages. **Check this list before writing any new layout markup.**

| Component | File | Use For |
|-----------|------|---------|
| `PageHeader` | `page-header.tsx` | Every internal page title bar |
| `PageContent` | `page-content.tsx` | Every scrollable page body with padding + max-width |
| `StatsStrip` | `stats-strip.tsx` | 4-column KPI card grids |
| `SearchInput` | `search-input.tsx` | Any search field with icon prefix |
| `FilterPills` | `filter-pills.tsx` | Category/status toggle pill filters |
| `SectionLabel` | `section-label.tsx` | Uppercase eyebrow labels inside content |

## Premium Motion Patterns (2026-05-08)

| Pattern | File | Description |
|---------|------|-------------|
| `Route Enter Motion` | `apps/web/src/routes/__root.tsx` | `opacity 0→1 + y:4→0` spring on route change via `AnimatePresence mode="wait"`. Key = `location.pathname`. `prefers-reduced-motion` safe — y translation skipped when reduced. |
| `Auth Card Glass` | All 4 auth pages via `auth-card.tsx` | `surface-glass-2` on auth card (`backdrop-blur-xl bg-background/75`). Spring entrance `opacity 0→1 y:24→0`. Staggered fields with `staggerFast` from motion.ts. |
| `Auth Success State` | `forgot-password-page.tsx`, `reset-password-page.tsx` | `AnimatePresence` form→success swap. Success shows icon (`CheckCircle2` / `ShieldCheck`) with spring scale-in. Reset-password auto-navigates to `/` after 1.5s. |
| `Bell Hover Spring` | `apps/web/src/components/app-shell.tsx` | `whileHover={{ scale: 1.05 }}` with `springSnap` on notification bell. |
| `Approve SignatureBurst` | `apps/web/src/components/inbox/inbox-action-bar.tsx` | `SignatureBurst variant="approve"` fires on Approve click. Relative overflow-hidden parent required. `showBurst` state resets onComplete. |
| `Inbox Detail Spring` | `apps/web/src/components/inbox/inbox-detail-pane.tsx` | `AnimatePresence mode="wait"` on detail pane body. `key={response.id + activeSection}` triggers x:8→0 + opacity on row selection. prefers-reduced-motion: opacity only. |
| `Glass Action Bar` | `inbox-action-bar.tsx`, pattern reusable on any fixed action bar | `border-t bg-background/90 backdrop-blur-sm`. Use on any sticky bottom action bar where list content scrolls beneath. |
| `Row Hover Lift` | `apps/web/src/components/requests/requests-row.tsx` | CSS-only `translate-y-[-1px] shadow-sm` on the inner Link div. Safe with react-window (outer wrapper stays fixed). Pattern for ALL virtualised list rows. |

| `Card Enable Glow Ring` | `apps/web/src/components/actions/action-card.tsx` | `border-primary/30 + shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]` on enabled cards. CSS-only, no framer-motion. |

## Page Patterns (2026-05-10)

| Pattern | Location | Description |
|---------|----------|-------------|
| `Full-Screen Builder` | `/create`, `/actions/create` | Full viewport canvas. No sidebar, no topbar. `FULLSCREEN_ROUTES` in `app-shell.tsx` strips the shell. Structure: fixed header (× close, centered step dots, optional right widget) + scrollable main. Aurora background on compose/generating steps. Standard `bg-background` on review/edit steps. Always include ReducedMotion support via `MotionConfig reducedMotion="user"`. |
| `Connector Brand Tile` | `/connectors` `ConnectorBrandTile` | White card `rounded-xl border bg-card p-4`. Brand avatar: `size-10 rounded-xl` with hardcoded `brandColor` bg class and white initials `text-sm font-bold`. Hover: `scale-[1.015] shadow-md transition-all duration-200`. Connected state: `CheckCircle2 text-emerald-600` + DropdownMenu `···`. Not-connected: outline Connect button. No mcp:// URLs, auth badges, or tool counts visible. |
| `AI Compose → Review` | `/create`, `/actions/create` | 3-step: Describe (Aurora + ghost textarea + chips) → Composing (Aurora + spinning card + Typewriter lines) → Review (standard bg, centered card, hero visual + editable fields). Describe: ghost `textarea` with animated gradient underline + progress meter. Composing: `border-2 border-transparent border-t-primary/60 animate rotate-360` spinner ring around card. Review: hero avatar/visual centered above form fields, entrance `y:24→0 opacity spring`. Generate button appears only when `input.trim().length >= 6`. |
