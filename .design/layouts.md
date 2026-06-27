# Layouts Ledger

## Layout Language

Use these layout names in plans, issues, PRs, code comments, and implementation notes. Every page should have one primary name from this file. The canonical names are deliberately plain so the team can say "this is a list layout" or "this is an inbox layout" without inventing a new visual language.

| Canonical Name | Use When | Core Anatomy | Live Pages |
|----------------|----------|--------------|------------|
| `App Shell Layout` | The page is an authenticated internal app screen | Left sidebar, sticky topbar, main outlet canvas | `components/app-shell.tsx`, all `routes/_app/*` routes |
| `Dashboard Layout` | One page summarizes activity, status, and next actions | Page header, optional attention/status strip, stacked section cards, optional secondary rail | `billing/billing-page.tsx` (dashboard revived in phase-3) |
| `List Layout` | The page manages many records in one place | Page header, optional stats strip, filter/search row, scrollable list/grid/table, optional footer summary | `requests/requests-page.tsx` |
| `Request Detail Layout` | One request needs multiple working modes or operational tabs | Sticky detail header, local tab strip, main working pane, optional utility rail | `requests/request-detail-page.tsx` |
| `Inbox Layout` | A user reviews records from a worklist without leaving the page | Fixed list rail, filter/search controls, persistent detail pane, fixed action bar | `inbox/inbox-page.tsx` |
| `Full-Screen Builder Layout` | A user builds or publishes something without sidebar or topbar | Aurora/brand background, centered step header, step tracker, × exit, no app shell chrome | `create/create-request-page.tsx`, `actions/create-action-page.tsx` |
| `Settings Layout` | A user manages settings, team, actions, or configuration inside the app shell | Page header, local nav (sidebar or tabs), stacked config sections, cards, or tables | `settings/settings-page.tsx`, `team/team-page.tsx`, `actions/actions-page.tsx`, `connectors/connectors-page.tsx` |
| `Compare Layout` | A page compares multiple variants side-by-side | Selector strip, metric matrix, side-by-side comparison cards, summary strip | `cohorts/compare-page.tsx` |
| `Public Form Layout` | The page is a single-column public or auth task with no app shell | Centered or narrow canvas, optional card wrapper, one primary task flow | `auth/login-page.tsx`, `auth/signup-page.tsx`, `auth/forgot-password-page.tsx`, `auth/reset-password-page.tsx`, `responder/responder-page.tsx` |

## Layout Details

**App Shell Layout**
- Location: `apps/web/src/components/app-shell.tsx`
- Used by: all authenticated `routes/_app/*` pages
- Structure: sidebar navigation, sticky topbar, scrollable main canvas
- Guardrail: public routes do not use `App Shell Layout`

**Dashboard Layout**
- Use for: billing/status summary pages; planned for future operational dashboard
- Common zones: page header, optional attention bar, bordered section cards, optional right utility rail
- Widths in live code: `max-w-5xl`, `max-w-[1400px]`, `grid-cols-12` with `8/4` split when a right rail exists
- Guardrail: if the page becomes tab-heavy or deeply editable, move it to `Request Detail Layout` or `Full-Screen Builder Layout`, not a new layout

**List Layout**
- Use for: many records with search, filters, and repeatable item rows or cards
- Live variants: row list (`Requests`), card grid (`ConnectorsPage`, `ActionsPage`)
- Common zones: page header, optional KPI strip, filter row, collection body, optional footer totals
- Guardrail: new collection pages should reuse an existing variant before inventing a new layout wrapper

**Request Detail Layout**
- Use for: detail pages with multiple working modes, tabs, and a utility rail
- Common zones: sticky header, local tab strip, main work pane, secondary utility rail or action rail
- Live example: `requests/request-detail-page.tsx`
- Guardrail: local tabs belong directly under the sticky header, not scattered through the body

**Inbox Layout**
- Use for: inbox/review flows where the user selects from a worklist and acts in-place
- Live widths: left rail `w-[380px]`, right detail pane `flex-1`
- Common zones: list header, search/filter row, worklist rows, detail pane tabs, fixed approve/reject action bar
- Guardrail: treat the list rail and detail pane as one layout; do not split them into unrelated standalone layouts

**Full-Screen Builder Layout**
- Use for: creation or configuration flows with guided steps where the app shell chrome is removed entirely
- Live structure: Aurora/brand background, step header with × exit and step tracker, centered content, animated transitions between steps
- FULLSCREEN_ROUTES in `app-shell.tsx`: `["/create", "/actions/create"]` — these paths suppress sidebar and topbar
- Guardrail: creation flows should land in `Full-Screen Builder Layout` before inventing ad hoc wizard layouts; do not use Sheet/drawer for these flows

**Settings Layout**
- Use for: settings, team, roles, action configuration, and other management screens
- Live variants: rail navigation (`Settings`), top tab navigation (`Team`, `Actions`)
- Common zones: page header, local nav, stacked settings sections, tables, cards, dialogs
- Guardrail: use `Settings Layout` only for management/configuration pages inside the app shell

**Public Form Layout**
- Use for: auth and public flows outside the app shell
- Live variants: auth card (`Login`, `Signup`), public form flow (`Responder`)
- Live widths: `max-w-md` for auth, `max-w-xl` for responder
- Guardrail: keep one primary task per page and avoid mixing app-shell interaction patterns into public form pages

## Shared Layout Primitives

| Primitive | Import Path | Purpose |
|-----------|-------------|---------|
| `PageContent` | `components/common/page-content` | Centered content wrapper with consistent horizontal padding; `maxWidth` prop (`4xl`\|`5xl`\|`6xl`\|`full`, default `6xl`). Use inside any layout that needs a constrained content column. |
| `sidebar` | `@requestflo/ui/components/ui/sidebar` | Application shell sidebar primitives |
| `sheet` | `@requestflo/ui/components/ui/sheet` | Slide-out mobile or secondary panels |
| `resizable` | `@requestflo/ui/components/ui/resizable` | Resizable panel groups when a split view needs user control |
| `scroll-area` | `@requestflo/ui/components/ui/scroll-area` | Controlled scroll containers inside constrained panes |
| `separator` | `@requestflo/ui/components/ui/separator` | Visual separation between layout zones |

## Selection Rules

1. Every new page must choose one primary canonical name from this file.
2. Cosmetic differences do not justify a new layout.
3. A new layout is allowed only when all current layouts fail structurally, not stylistically.
4. If a new layout is needed, document it here before it spreads to multiple pages.
