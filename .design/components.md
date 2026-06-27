# Components Ledger

## 2026-06 Premium Redesign — Current Component APIs

The premium refactor (June 2026) changed several shared APIs. These are the current contracts:

| Component | API | Notes |
|-----------|-----|-------|
| `PageHeader` (`common/page-header.tsx`) | `{ title, subtitle?, children?, belowTitle? }` | px-8 gutter, title `text-xl font-semibold tracking-tight`; `children` = right-side actions |
| `PageContent` (`common/page-content.tsx`) | `{ maxWidth?: "4xl"\|"5xl"\|"6xl"\|"full" }` | px-8 py-6 scrolling content area |
| `StatsStrip` (`common/stats-strip.tsx`) | `stats: { label, value, icon?, hint?, tone?: default\|accent\|success\|warning\|destructive }[]`, `cols?: 2\|3\|4` | ONE bordered surface with internal dividers; no colored icon circles; `iconBg` deprecated |
| `FilterPills` (`common/filter-pills.tsx`) | `options: { id, label, count? }[]`, `value`, `onChange` | Segmented control with animated thumb (framer layoutId) |
| `SearchInput` (`common/search-input.tsx`) | unchanged props | Quiet muted style, borderless until focus |
| `CommandPalette` (`components/command-palette.tsx`) | `{ open, onOpenChange }` | ⌘K palette in AppShell: pages, New request, recent requests |
| `status-config.ts` (`components/requests/`) | `getStatusConfig(status)`, `getFloStatusConfig(status)` | Single source of truth for status color/dot/label; safe on unknown strings |
| `lib/format.ts` | `formatRelativeTime`, `formatDate`, `formatDateTime` | Local timezone, plain English |
| `lib/use-copy.ts` | `useCopyToClipboard()` → `{ copied, copy }` | Use for every Copy-link button |
| Badge (`@requestflo/ui`) | variants: `default secondary destructive outline success warning accent muted` | Use semantic variants, not custom classes |
| `ConnectorsPage` | `{ embedded?: boolean }` | `embedded` renders without PageHeader/gutters (used by Settings → Connectors) |

**Cross-surface semantics:** "to review" = responses with backend status `validated` (waiting on a human). The sidebar Inbox badge, Inbox Review filter, Requests-list chips, and Request-detail stats all use this one definition. Rejected = handled (revisit via the Rejected filter, "Approve instead").

**Fullscreen (chrome-less) routes** are prefix-matched in `app-shell.tsx`: `/requests/create`, `/actions/create`, `/preview`.

## Canonical Boundary

- Shared primitives and providers live in `packages/ui`.
- Page-level layouts, app shell, and domain composites live in `apps/web/src/components`.
- Every new page must pick a named layout in `layouts.md` before adding new wrappers or composites.
- Prefer `@requestflo/ui/components/ui/*` for any primitive that already exists.
- Raw HTML `input` and `button` elements currently remain only in `LoginPage`, `SignupPage`, and `FloItemCard`. Treat that as contained drift. Do not copy it into new internal pages.
- `panel`, `panel-header`, `panel-title`, and `data-table` are not documented shared utilities. They appear only in legacy prototype pages and must not spread until replaced or formally defined.

## App Page Components (`apps/web/src/components/`)

| Component | Layout | Route(s) | Shared UI Used | Purpose |
|-----------|--------|----------|----------------|---------|
| `AppShell` | `App Shell Layout` | all `_app/*` pages | `Button`, `Sidebar`, `DropdownMenu`, `Avatar` | Authenticated app shell with sidebar, topbar, and main outlet |
| `BillingPage` | `Dashboard Layout` | `/billing` | `Button`, `Badge`, `Progress` | Billing, usage, plans, invoices, and workspace summary |
| `RequestsPage` | `List Layout` | `/requests` | `Button`, `Input`, `Progress`, `DropdownMenu` | Request list with filters, search, and row summaries |
| `RequestDetailPage` | `Request Detail Layout` | `/requests/$id` | `Button`, `Badge`, `Progress`, `Tabs`, `DropdownMenu` | Tabbed request detail workspace with utility rail |
| `InboxPage` | `Inbox Layout` | `/inbox` | `Button`, `Input`, `Textarea`, `Badge` | Worklist and detail review experience |
| `CreateRequestPage` | `Full-Screen Builder Layout` | `/create` | `Button`, `Input`, `Textarea`, `Switch`, `Badge` | Guided request builder with preview and publish states |
| `ConnectorsPage` | `Settings Layout` | `/connectors` | `Button`, `Badge`, `Card` | Brand tile grid of connectors with category chips, connected section, and custom CTA |
| `ActionsPage` | `Settings Layout` | `/actions` | `Button`, `Card`, `Input`, `Badge`, `DropdownMenu` | Action library card grid with brand avatars and connect state |
| `CreateActionPage` | `Full-Screen Builder Layout` | `/actions/create` | `Button`, `Input`, `Textarea`, `Badge` | AI-powered 3-step action creation: Describe → Composing → Review |
| `SettingsPage` | `Settings Layout` | `/settings` | `Button`, `Input`, `Badge`, `Switch`, `Tabs`, `Avatar`, `Select` | Account, workspace, API, and webhook configuration |
| `TeamPage` | `Settings Layout` | `/team` | `Button`, `Card`, `Input`, `Badge`, `Avatar`, `DropdownMenu`, `Dialog`, `Select`, `Table`, `Tabs` | Team members, pending invites, and role management |
| `LoginPage` | `Public Form Layout` | `/login` | none yet | Public login page |
| `SignupPage` | `Public Form Layout` | `/signup` | none yet | Public signup page |
| `ForgotPasswordPage` | `Public Form Layout` | `/forgot-password` | none yet | Password reset request page |
| `ResetPasswordPage` | `Public Form Layout` | `/reset-password` | none yet | Password reset confirmation page |
| `ResponderPage` | `Public Form Layout` | `/r/$requestId` | `Button`, plus `FloItemCard` | Public responder flow with working API logic |

## Page-Local Composites Worth Naming

| Composite | Location | Used By | Notes |
|-----------|----------|---------|-------|
| `ResponseRow` | `components/inbox/inbox-page.tsx` | `InboxPage` | Canonical worklist row for the `Inbox Layout` |
| `DetailPanel` | `components/inbox/inbox-page.tsx` | `InboxPage` | Canonical detail pane for the `Inbox Layout` |
| `SettingSection` | `components/settings/settings-section.tsx` | `SettingsPage` | Canonical bordered section wrapper for `Settings Layout` pages |
| `SettingRow` | `components/settings/settings-page.tsx` | `SettingsPage` | Canonical row wrapper inside `SettingSection` |
| `ConnectorBrandTile` | `components/connectors/connector-brand-tile.tsx` | `ConnectorsPage` | Brand tile with letter avatar, name, category, and connect/connected state |
| `ConnectorCategoryChips` | `components/connectors/connector-category-chips.tsx` | `ConnectorsPage` | Category filter chips for connector grid |
| `ConnectedSection` | `components/connectors/connected-section.tsx` | `ConnectorsPage` | Strip of currently connected connectors |
| `ConnectorCustomCta` | `components/connectors/connector-custom-cta.tsx` | `ConnectorsPage` | Dashed CTA card for adding a custom MCP connector URL |
| `ActionCard` | `components/actions/action-card.tsx` | `ActionsPage` | Brand avatar card for an action with connector + tool metadata |
| `CreateActionDescribe` | `components/actions/create-action-describe.tsx` | `CreateActionPage` | Step 1: Aurora background + chip suggestions for AI description |
| `CreateActionComposing` | `components/actions/create-action-composing.tsx` | `CreateActionPage` | Step 2: Orb + typewriter composing state |
| `CreateActionReview` | `components/actions/create-action-review.tsx` | `CreateActionPage` | Step 3: Large connector avatar, editable fields, Save |
| `FloItemCard` | `components/responder/flo-item-card.tsx` | `ResponderPage` | Canonical submission card for the public responder flow |
| `PageHeader` | `components/common/page-header.tsx` | Multiple pages | Reusable page header with title, description, and actions |
| `StatsStrip` | `components/common/stats-strip.tsx` | Multiple pages | Reusable compact KPI strip |
| `AuthPageShell` | `components/auth/auth-page-shell.tsx` | `LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage` | Shared auth page layout wrapper |
| `AuthFormField` | `components/auth/auth-form-field.tsx` | Auth pages | Shared form field for auth pages |
| `SlugField` | `components/auth/slug-field.tsx` | `SignupPage` | Workspace slug input for signup |
| `CreateRequestForm` | `components/create/create-request-form.tsx` | `CreateRequestPage` | Main form orchestrator for the request builder |
| `CreateRequestMagic` | `components/create/create-request-magic.tsx` | `CreateRequestPage` | AI-powered magic generation panel |
| `CreateRequestDescribe` | `components/create/create-request-describe.tsx` | `CreateRequestPage` | Plain-English description step |
| `CreateRequestComposing` | `components/create/create-request-composing.tsx` | `CreateRequestPage` | Composing/editing step |
| `CreateRequestSettings` | `components/create/create-request-settings.tsx` | `CreateRequestPage` | Settings panel in builder |
| `CreateRequestPreview` | `components/create/create-request-preview.tsx` | `CreateRequestPage` | Live preview panel |
| `CreateRequestPublish` | `components/create/create-request-publish.tsx` | `CreateRequestPage` | Publish/share step |
| `CreateRequestFields` | `components/create/create-request-fields.tsx` | `CreateRequestPage` | Generated fields editor |
| `CreateRequestActions` | `components/create/create-request-actions.tsx` | `CreateRequestPage` | Action configuration |
| `DeviceToggle` | `components/create/device-toggle.tsx` | `CreateRequestPage` | Mobile/desktop preview toggle |
| `DevicePreview` | `components/create/device-preview.tsx` | `CreateRequestPage` | Device frame preview wrapper |
| `MagicChatPanel` | `components/create/magic-chat-panel.tsx` | `CreateRequestPage` | Chat-style AI interaction panel |
| `TweakPill` | `components/create/tweak-pill.tsx` | `CreateRequestPage` | Quick tweak action pill |
| `RequestsList` | `components/requests/requests-list.tsx` | `RequestsPage` | Virtualized request list |
| `RequestsRow` | `components/requests/requests-row.tsx` | `RequestsPage` | Single request row |
| `RequestsFilters` | `components/requests/requests-filters.tsx` | `RequestsPage` | Filter bar for requests |
| `RequestRowActions` | `components/requests/request-row-actions.tsx` | `RequestsPage` | Row-level action dropdown |
| `RespondentForm` | `components/respondent/respondent-form.tsx` | `ResponderPage` | Public respondent submission form |
| `TeamStats` | `components/team/team-stats.tsx` | `TeamPage` | Team KPI strip |
| `TeamInviteDialog` | `components/team/team-invite-dialog.tsx` | `TeamPage` | Invite member dialog |
| `TeamTable` | `components/team/team-table.tsx` | `TeamPage` | Members table |
| `CreateWorkspaceDialog` | `components/create-workspace-dialog.tsx` | `AppShell` | Workspace creation dialog |
| `OnboardingWorkspaceBanner` | `components/onboarding-workspace-banner.tsx` | `AppShell` | Onboarding prompt banner |
| `UserMenu` | `components/user-menu.tsx` | `AppShell` | User dropdown in topbar |

## Shared UI Boundary (`packages/ui`)

| Export | Import Path | Source | Purpose |
|--------|-------------|--------|---------|
| `ThemeProvider`, `useTheme` | `@requestflo/ui/components/theme-provider` | `packages/ui/src/components/theme-provider.tsx` | Theme mode state and root class management |
| `use-mobile` | `@requestflo/ui/hooks/use-mobile` | `packages/ui/src/hooks/use-mobile.ts` | Mobile viewport helper |
| `use-toast`, `toast` | `@requestflo/ui/hooks/use-toast` | `packages/ui/src/hooks/use-toast.ts` | Toast state and imperative toast API |
| `devices` | `@requestflo/ui/components/devices` | `packages/ui/src/components/devices/index.ts` | Device frame preview components |
| `aurora` | `@requestflo/ui/components/aurora` | `packages/ui/src/components/aurora/index.ts` | Aurora background animation |
| `typewriter` | `@requestflo/ui/components/typewriter` | `packages/ui/src/components/typewriter/index.ts` | Typewriter text animation |

## Shared Primitive Usage In App

| Shared Primitive | Used By Page Components |
|------------------|-------------------------|
| `Avatar` | `AppShell`, `SettingsPage`, `TeamPage` |
| `Badge` | `BillingPage`, `ConnectorsPage`, `CreateRequestPage`, `FloItemCard`, `InboxPage`, `RequestDetailPage`, `SettingsPage`, `TeamPage`, `ActionsPage`, `CreateActionPage` |
| `Button` | `AppShell`, `BillingPage`, `ConnectorsPage`, `CreateRequestPage`, `InboxPage`, `RequestDetailPage`, `RequestsPage`, `ResponderPage`, `SettingsPage`, `TeamPage`, `ActionsPage`, `CreateActionPage` |
| `Card` | `ActionsPage`, `ConnectorsPage`, `TeamPage` |
| `Checkbox` | (none currently) |
| `Dialog` | `TeamPage` |
| `DropdownMenu` | `AppShell`, `RequestsPage`, `RequestDetailPage`, `TeamPage`, `ActionsPage` |
| `Input` | `CreateRequestPage`, `InboxPage`, `RequestsPage`, `SettingsPage`, `TeamPage`, `ActionsPage` |
| `Progress` | `BillingPage`, `RequestsPage`, `RequestDetailPage` |
| `Select` | `SettingsPage`, `TeamPage` |
| `Sidebar` | `AppShell` |
| `Switch` | `CreateRequestPage`, `SettingsPage` |
| `Table` | `TeamPage` |
| `Tabs` | `RequestDetailPage`, `SettingsPage`, `TeamPage` |
| `Textarea` | `CreateRequestPage`, `InboxPage` |

## Shared Primitives (`packages/ui/src/components/ui/`)

| Category | Components |
|----------|------------|
| Layout and navigation | `accordion`, `breadcrumb`, `button-group`, `collapsible`, `navigation-menu`, `pagination`, `resizable`, `scroll-area`, `separator`, `sheet`, `sidebar`, `tabs` |
| Form inputs | `button`, `calendar`, `checkbox`, `field`, `form`, `input`, `input-group`, `input-otp`, `label`, `radio-group`, `select`, `slider`, `switch`, `textarea`, `toggle`, `toggle-group` |
| Overlays and menus | `alert-dialog`, `command`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `hover-card`, `menubar`, `popover`, `tooltip` |
| Display and feedback | `alert`, `aspect-ratio`, `avatar`, `badge`, `card`, `carousel`, `chart`, `empty`, `item`, `kbd`, `progress`, `skeleton`, `sonner`, `spinner`, `table`, `toast`, `toaster` |

## Known Drift

- `use-toast` is a hook, not a component. The canonical source is `packages/ui/src/hooks/use-toast.ts`.
- Auth and responder pages still use raw form controls. New internal UI should keep using shared `Input`, `Button`, and related primitives.

## Common App Components (`apps/web/src/components/common/`)

These are shared composites used across multiple pages. **Check here before building a new wrapper.**

| Component | File | Props | Used By | Notes |
|-----------|------|-------|---------|-------|
| `PageHeader` | `common/page-header.tsx` | `title`, `description?`, `actions?`, `className?` | All app pages | Single unified style: `text-2xl font-semibold tracking-tight`, `px-8 pt-6 pb-5 border-b`. No variant prop. |
| Primitive | Import Path | Purpose |
|-----------|-------------|---------|
| `PageContent` | `components/common/page-content` | Centered content wrapper with consistent horizontal padding; `maxWidth` prop (`4xl`\|`5xl`\|`6xl`\|`full`, default `6xl`). Used by Connectors, Actions, Team, Billing |
| `SearchInput` | `components/common/search-input` | Standardised `h-9 pl-9` search input with search icon. Used by `RequestsFilters`, `InboxPage`, `TeamTable`, `ActionsPage` |
| `FilterPills` | `components/common/filter-pills` | Row of pill toggle buttons; active = `bg-foreground text-background`. Used by `ConnectorsPage`, `RequestsFilters` |
| `SectionLabel` | `common/section-label.tsx` | `as?: "div"\|"span"\|"h3"\|"p"\|"th"` (default `"div"`), `className?`, `children` | InboxDetailPane (×5), CreateRequestForm (×4) | Eyebrow / section label text; semantic `as` prop for flexibility |
| `StatsStrip` | `common/stats-strip.tsx` | `stats: StatItem[]`, `cols?: 2\|3\|4` (default `4`), `className?` | ActionsStats, TeamStats, MCPServersStats | Stat card grid; each item has `label`, `value`, `icon?`, `color?` |

## Premium Shell Components (2026-05-08)

| Component | File | Notes |
|-----------|------|-------|
| `AuthCard` | `apps/web/src/components/auth/auth-card.tsx` | Glass auth card with WavesIcon brand mark + spring entrance. Used by all 4 auth pages. Accepts `title`, `description?`, `children`, `className?`. |

## Premium Primitives (Wave 1 — 2026-05-08)

All live in `packages/ui/src/components/ui/`. Import via `@requestflo/ui/components/ui/*`.

| Component | Import path | Description | Key props |
|-----------|-------------|-------------|-----------|
| `GlassSurface` | `@requestflo/ui/components/ui/glass-surface` | Polymorphic div wrapper applying surface-glass-1/2/3 CSS utility | `variant: 1\|2\|3`, `as?: ElementType` |
| `StaggerList` | `@requestflo/ui/components/ui/stagger-list` | motion.div container that staggers children on mount | `delay?: number`, `className?` |
| `StaggerItem` | `@requestflo/ui/components/ui/stagger-list` | motion.div child for use inside StaggerList | `className?` |
| `RowAccent` | `@requestflo/ui/components/ui/row-accent` | Thin vertical accent bar for list rows | `className?` (override color) |
| `AnimatedTabContent` | `@requestflo/ui/components/ui/animated-tab-content` | TabsContent wrapper with spring fade+slide entrance | All TabsContent props |
| `SlidingTabIndicator` | `@requestflo/ui/components/ui/sliding-tab-indicator` | Framer layoutId underline indicator for active tab | `layoutId: string` (required, unique per page) |
| `DisplayHeading` | `@requestflo/ui/components/ui/display-heading` | Lightweight tracking-tight heading for hero moments | `as?: h1\|h2\|h3\|p`, `size?: xl\|lg\|md` |
| `MetricNumber` | `@requestflo/ui/components/ui/metric-number` | Applies metric-lg/md/sm CSS class with optional label | `size?: lg\|md\|sm`, `label?: string` |
| `CountUp` | `@requestflo/ui/components/ui/count-up` | Animated number count-up using framer-motion animate() | `from?`, `to`, `duration?`, `format?` |
| `SignatureBurst` | `@requestflo/ui/components/ui/signature-burst` | One-shot success burst overlay (approve/publish/transmit) | `variant: approve\|publish\|transmit`, `onComplete?` |
| `FlowMeter` | `@requestflo/ui/components/ui/flow-meter` | SVG arc meter for Flow credit usage | `used`, `max`, `size?: sm\|md\|lg` |
| `StatusGlow` | `@requestflo/ui/components/ui/status-glow` | Ambient radial gradient glow overlay | `color: success\|warning\|destructive\|primary`, `intensity?: subtle\|soft\|strong` |
| `FloatingSaveBar` | `@requestflo/ui/components/ui/floating-save-bar` | Fixed bottom-center pill bar for dirty form state | `dirty`, `onSave`, `onDiscard`, `label?`, `saving?` |

## Shared Primitive Usage In App (2026-05-08)

| Shared Primitive | Used By Page Components |
|------------------|-------------------------|
| `FlowMeter` | `BillingPage` (via `FlowUsageWidget`) |
| `CountUp` | `BillingPage` (response count badge) |
| `StaggerList` / `StaggerItem` | `CreateActionPage` (Describe step chips) |
| `GlassSurface` | `BillingPage` (flow usage widget via `FlowUsageWidget`) |
| `EmptyState (hero variant)` | `RequestsPage`, `ActionsPage` |
