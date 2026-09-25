---
name: hot-signal-design
description: Hot Signal, Calm Layers edition — the swarmy apps/app design system. Every screen reads at three depths (Summary · Controls · Code); sentence headlines; one coral action; the seven-row navy sidenav + mobile tab bar; tokens, type, the components/calm primitives and the glossary. Load before touching anything in apps/app.
---

## When to use me

Load before touching **anything in `apps/app`** (swarmy's dashboard): new
screens, components, copy or layout. `apps/web` (marketing) shares the Hot
Signal tokens through `@swarmy/ui` — see `skill("design-reference")`.

The build plan and the route → board map live in `plans/redesign-build.md`.
The boards (68-board canvas + the Calm Layers R-boards) are the visual source.

## The direction

> **A calm ops console. Plain words first, expert power one switch away.**

- **Calm** — the screen says what's true in a sentence and offers the one thing
  worth doing. Everything healthy stays quiet.
- **Bold where it's earned** — Bricolage display type, navy statement nav,
  coral on the one action. Never timid, never loud for its own sake.
- **Honest** — never a fake zero; unknown is a skeleton. Code views show only
  real REST paths, real CLI commands and real swarmy.yaml keys.
- **Easy for novices, fast for experts** — the same page serves both through
  depth, not through two products.

## Calm Layers: three depths (non-negotiable)

| Depth | Shows | Rule |
|---|---|---|
| **Summary** | A sentence headline, a lede with the numbers, the one next action | No glossary words (see Voice) |
| **Controls** | The forms and knobs, technical detail inline as mono `Tech` lines | Replaces every `Advanced ▸` and `Raw` toggle |
| **Code** | `CodeView`: the exact swarmy.yaml / CLI / REST, with where it lives ("opens a PR" / "dashboard setting") | Only real commands and paths |

- **Depth adds detail; it never rearranges the page.** Summary content stays
  where it is at Controls and Code. The Code view goes at the top of the aside.
- **Per-person default.** The sidenav "Show me" dial (phone: the user menu)
  sets it; the top-bar switch changes this page only and resets on navigation;
  a `Section switchable` can go its own way. Saved per person server-side
  (`org.myPreferences` / `setMyPreferences`), cached in localStorage
  (`swarmy-depth:<userId>`). First run asks (the RWelcome card on Overview).
- **No screen ships without its Summary sentence and its Code view.**

## Page anatomy

1. **Top bar** (`CalmTopBar`, 52px): mono breadcrumb (`Apps / storefront`),
   quiet page actions, the depth switch.
2. **Sentence header** (`SayHeader`): optional mono eyebrow, the sentence
   (`<Say tone="warn">` on the clause that matters; `<em>` = the quieter second
   clause, muted, never italic, never coral), a lede with the numbers.
3. **Next action** (`NextAction`): what happened, why the fix is safe, the one
   coral button, the tech line at Controls. At most one per screen.
4. **Sections** (`Section`): quiet cards with an h2, a count, a mono "→" link.
   Lists are `CalmRow`s (dot · name/host · sentence · tech · status word) inside
   one section — never per-row cards.
5. **Aside** (400px on xl): facts, `AlreadyOn` lines ("Backups · 14 of 14 at
   03:00" — each a link to *change*), "Worth doing next", and the `CodeView`
   at Code depth.

Pages outside a tabbed row use `CalmPage`. Pages in a tabbed row (Network,
Data, Activity, Settings, the Deploy flow) use `SectionHeader`, which renders
the top bar, the sentence header and the row's tabs. App workspace tabs
render inside the one app header (`components/stacks/workspace/*`) and start
with a `SayHeader size="md"`.

## Components (`apps/app/src/components/calm/`)

`DepthProvider` · `useDepth()` / `useDepthDefault()` / `usePageDepth()` ·
`<Depth at="controls|code">` · `DepthDial` / `PageDepthSwitch` /
`DepthSegments` · `CalmPage` / `CalmTopBar` · `SayHeader` / `Say` ·
`NextAction` · `Section` / `SectionLink` · `CalmRow` / `RowList` · `AlreadyOn` ·
`Tech` · `CodeView` (+ `curl`, `restExchange`, `toYaml` in `code.ts`) ·
`CalmTabs` · `StatusWord`. Tones: `ok · warn · bad · info · mesh · idle`
(`TONE_TEXT` for words, `TONE_DOT` for dots). Reuse these; don't fork them.

## Shell & navigation

**Desktop (`lg` ≥ 1024px)** — fixed navy sidenav (`w-60`, `bg-nav`),
`components/shell/sidenav.tsx`: wordmark + workspace, coral **Deploy an app**,
**Ask or jump… ⌘K**, seven flat rows — **Overview · Apps · Servers · Network ·
Data │ Activity · Settings** — the servers-online footer, the "Show me" dial,
the user row. A row's pages are in-page tabs (`SECTIONS` by group in
`lib/destinations.ts`), never more nav rows. Active row: `--nav-active`
wash + semibold. Badges: amber mono counts rolled up onto their row.

**Mobile (< 1024px)** — header: wordmark, search, **All pages** sheet, avatar.
Tab bar: **Overview · Apps · coral + · Servers · Activity**. No hamburger.

Deploy is a verb (the coral nav button, ⌘K, `/deploy`), not a row. URLs are
stable: the IA regroups routes, it doesn't move them.

## Colour & tokens

Shared (`@swarmy/ui/src/styles.css`): `--primary` coral, `--ink` navy,
`--status-*` fills, `--background/--card/--border/--muted-foreground`.
App-only (`apps/app/src/styles/globals.css`):

- `--nav*` — the navy sidenav in both themes.
- `--code` — the Code panel (`.calm-code`).
- `--tone-ok/warn/bad/info/mesh/idle` → `text-tone-*`: status colours that
  clear **4.5:1 as text** on page and card in both themes. Use these for
  coloured words; `--status-*` (`bg-status-*`) are for dots and washes only.
- Light `--primary` is deepened (`oklch(0.58 0.2 29.5)`) so white-on-coral
  clears 4.5:1.

Coral = the one action. Green healthy, amber needs you, crimson down, blue in
flight, violet private network. No raw Tailwind palette colours.

## Typography

Bricolage Grotesque (`font-display`, `.say` 720 weight, tight tracking) for
sentences and section titles; Instrument Sans for UI; Geist Mono for
numbers, crumbs, eyebrows, tech lines and code. No serif, no italics.

## Voice & glossary

Talk like a calm, sharp colleague: "Three apps are calm. analytics is slow."
"Put back v41 — your data isn't touched and it takes about 40 seconds."

| At Summary say | Only at Controls/Code |
|---|---|
| app · server · address · front door | stack · node · route/ingress · driver |
| copies · standby copy · switch-over | replicas · replica · failover/promote |
| private network | mesh IP, overlay, WireGuard |
| saved / backed up · put back vN | snapshot, restic, PITR · rollback |

CTAs: "Deploy an app", "Add a server", "Add a domain", "Put back v41".

## Accessibility

Real `<button>`/`<Link>`, labels on icon buttons, `aria-pressed` on depth
switches, `aria-current` on active nav/tabs. 4.5:1 text contrast. 44px touch
targets on touch devices (`pointer-coarse:min-h-11`, `min-h-11`). Works at
390px. Motion only on the thing that needs you; respect reduced motion.

## States

Pending → `PageSkeleton` / `CardSkeleton` (`components/states/*`); a number
shows only once settled. A metric shown twice comes from one hook
(`lib/use-estate-summary.ts`). Empty states sell the next action.

## Do / Don't

- ✅ One coral action per screen (the nav's Deploy an app is the shell's).
- ✅ Sentence first, knobs at Controls, text form at Code.
- ✅ Quiet surfaces (`calm-card`): hairline borders, little shadow, little motion.
- ❌ No hero headlines, no `Advanced ▸`, no `Raw` toggle, no Form/compose split.
- ❌ No glossary words at Summary. No invented CLI commands or REST paths.
- ❌ No top nav bar, no hamburger. No raw palette colours.

## File map

- Tokens: `@swarmy/ui/src/styles.css`, `apps/app/src/styles/globals.css`.
- Calm primitives: `apps/app/src/components/calm/*`.
- Shell: `components/shell/{app-shell,sidenav,mobile-chrome,user-menu,command-palette}.tsx`.
- Headers: `components/section-header.tsx`, `components/page-header.tsx`.
- Nav model: `lib/destinations.ts`; app tabs: `lib/stack-nav.ts`.
- Data: `useTRPC()` + `useQuery(trpc.x.queryOptions())` (`skill("react-components")`);
  every new query needs a demo resolver (`src/demo/resolvers/*`).
