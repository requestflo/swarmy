---
name: hot-signal-design
description: Hot Signal — the swarmy apps/app design system. Principles, tokens, typography, shell (desktop navy sidenav + mobile tab bar), responsive rules, and the utility classes every apps/app surface must use. Load before touching anything in apps/app.
---

## When to use me

Load this skill before touching **anything in `apps/app`** (swarmy's dashboard) —
new screens, components, copy, or layout. This is the source of truth for the
product experience. `apps/web` is the marketing site and mirrors the same Hot
Signal tokens so login is zero-surprise — see `skill("design-reference")` for the
shared `@swarmy/ui` primitives.

## The direction — non-negotiable

swarmy's dashboard is, always:

> **Simple. Cool. Ultra premium. Bold. Easy to use — always.**

- **Simple** — one obvious thing to do per screen. Six destinations (Overview,
  Nodes, Services, Stacks, Ingress, Settings). No settings sprawl, no admin-panel
  chrome, no feature you have to explain. "Anyone can just deploy."
- **Cool & next-gen** — feels like a modern consumer app (Monzo / Linear energy),
  not a SaaS dashboard. Big confident type, colour used loudly but purposefully,
  moments of delight (count-ups on metrics, spring reveals, a live "It's online.").
- **Ultra premium** — generous whitespace, soft layered shadows, rounded-2xl
  cards, careful microcopy. Nothing cramped, nothing default-looking.
- **Bold** — chunky display headlines, the coral accent front and centre, navy ink
  blocks as statement surfaces. If a screen feels timid, it's wrong.
- **Easy to use — always** — the right info at the right time. The user always
  knows where they are (eyebrow + active nav), what matters now (hero statement /
  the big number), what to do next (one hot CTA), what's healthy (everything else
  stays quiet). No manual required.

## Typography

| Role | Font | Usage |
|---|---|---|
| Headlines | **Bricolage Grotesque** (`font-display`, ~750) | `.headline` class. Tight tracking, line-height 1.02. |
| Body / UI | **Instrument Sans** (`font-sans`) | Default body font. |
| Data | **Geist Mono** (`font-mono`) | Counts, CPU%, bytes, image tags, node ids, timestamps (`.mono-label`, `.mono-data`). |

- `<em>` inside a `.headline` renders as **hot coral, never italic** — the
  signature emphasis: "3 nodes need <em>you</em>." / "Everything's <em>green</em>."
- Serif and italics are banned. Numbers are heroes — lead with them in mono.

## Colour tokens (defined in `@swarmy/ui/src/styles.css`, consumed by both apps)

- `--primary` — hot coral `oklch(0.6534 0.2126 29.5)`. CTAs, emphasis, the live
  accent, the "y" wordmark dot, focus rings.
- `--ink` / `--ink-foreground` — deep navy statement surface (`.ink-block`):
  the sidenav, hero stat blocks, the install-node panel, bold empty states.
- `--status-*` — swarmy's cluster vocabulary, used via Tailwind color names
  (`text-status-online`, `bg-status-online/12`), never raw palette colors:
  - `online` (green) — node/service running & healthy.
  - `progress` (blue) — deploying / pulling / converging / pending action.
  - `warning` (amber) — degraded, draining, needs a human.
  - `offline` (crimson) — offline / failed / rejected.
  - `idle` (neutral) — pending enrolment, stopped, unknown.
- Background is warm off-white (light) / deep navy (dark); cards are pure white /
  elevated navy with `--border` hairlines.
- Semantics: coral = "act now / brand", green = "healthy/live", amber = "attention",
  crimson = "down", blue = "in flight", navy = "the product speaking".

## Utility classes (reuse, don't reinvent)

| Class | Purpose |
|---|---|
| `.headline` | Display headlines (Bricolage, bold, tight). `<em>` = coral. |
| `.eyebrow` | Pill page-marker at the top of every screen — wayfinding ("Overview", "New service"). |
| `.card-pop` / `.card-pop-hover` | Standard white/elevated rounded-2xl card with layered shadow / hover lift. |
| `.ink-block` | Navy filled statement surface. |
| `.mesh` | Soft coral/teal radial wash behind page heroes. |
| `.mono-label` / `.mono-data` | Mono uppercase micro-labels / tabular data values. |
| `.pulse-dot` | Live indicator (a node streaming, a deploy converging). |
| `.shimmer-line` | Loading/awaiting-first-sample skeleton. |

Buttons: pill (`rounded-full`), `font-bold`; primary = coral with
`shadow-[0_8px_24px_-8px_var(--primary)]` + `hover:scale-[1.03]`. Destructive =
outline crimson. One coral CTA per screen.

## Dark mode

First-class, not an afterthought.

- The user setting lives in the **user dropdown** (sidenav footer on desktop,
  avatar menu on mobile): Appearance → Light / Dark / System, via
  `apps/app/src/components/theme-menu.tsx`, using next-themes (`attribute="class"`,
  storage key `swarmy-app-theme`).
- Dark tokens live in the `.dark` block of `@swarmy/ui/src/styles.css`: deep navy
  background, elevated navy cards, brightened coral/status colours.
- **`--ink` in dark is an *elevated* navy, not an inversion** — the statement
  surface reads as lift, `--ink-foreground` stays light. Anything that must pop
  against ink in both modes uses `bg-ink-foreground text-ink` (e.g. the sidenav
  active pill), never `bg-card`/`bg-white`.
- Hard-coded oklch in a utility (mesh, shadows) gets a `.dark` override beside it.
  Token-driven styles need nothing. Test every surface in both themes.

## Shell & navigation

**Desktop (`lg` ≥ 1024px)** — fixed left **navy sidenav** (`w-64`, `.ink-block`),
`apps/app/src/components/shell/sidenav.tsx`:
1. Wordmark (white "swarm" + coral "y").
2. Coral "Create" pill + ⌘K search.
3. Nav: **8 flat destinations, never accordions/collapsing groups** — the 3
   anchors (Overview / Stacks / Infrastructure) then one row per section
   (Deploy / Platform / Operations / Governance / Settings, from `NAV_GROUPS`
   in `lib/destinations.ts`). Active item is a **white pill with navy text**
   (`bg-ink-foreground text-ink`); attention badges are coral counts rolled up
   onto the row they belong to (nodes offline on Infrastructure, alerts +
   incidents on Operations).
4. A quiet status footer: "N/M nodes online" with a `.pulse-dot`.
5. User row + theme menu + sign-out at the bottom.

**Section surfaces** — a section's children (e.g. Governance → Guardrails /
Exposure / Access & roles / Audit log / Cost) are **in-page tabs, not nav
rows**: every page in a section renders `SectionHeader`
(`apps/app/src/components/section-header.tsx`) instead of `PageHeader` — the
section supplies the eyebrow and a coral-underline tab row with live badges;
the page keeps its own data-driven headline. A new feature in a section
becomes a tab, never a new sidenav row.

**Mobile (< 1024px)** — `apps/app/src/components/shell/mobile-chrome.tsx`:
- `MobileHeader` — compact sticky header: wordmark + avatar only.
- `MobileTabBar` — fixed bottom tab bar: Overview, Nodes, **centre coral `+` FAB**
  (deploys a new service), Services, Settings. Safe-area padded; content gets
  `pb-28` so the bar never covers it.

**Breakpoint rule:** the layout swap happens at **`lg` (1024px)**. For JS-driven
swaps use `useBelowLg()` from `apps/app/src/lib/use-below-lg.ts`.

**No top nav bar. No hamburger menus.** Desktop is the sidenav; mobile is the
always-visible tab bar.

## Page anatomy (every screen)

1. `.eyebrow` page marker (wayfinding).
2. `.headline` hero — a statement with the key number, coral `<em>` on the word
   that matters. Optionally over a `.mesh` wash.
3. One coral CTA (if the screen has a primary action).
4. The data: `.card-pop` surfaces; KPI rows as big mono numbers with `count-up`;
   live series in hand-tuned charts (coral line, never stock chart-library
   chrome); lists are **flat rows in one card** divided by hairlines (hover wash,
   selection = soft `bg-accent` + 3px coral left rail) — never per-row cards.
5. Status always via `--status-*` tokens + `StatusBadge`.
6. Every empty state sells the next action ("No nodes yet — add one." with the CTA),
   never "No data available".

## Width strategy

Width goes to data, focus goes to input.
- The shell `<main>` is full-width; each page owns its container. Data surfaces:
  `mx-auto w-full max-w-[1600px] px-6 xl:px-10` + `lg:pb-20`.
- Master-detail surfaces (node detail, service logs) follow the email-client
  pattern: full-height columns that scroll independently, pinned action footer.
- Focus surfaces stay narrow: the new-service form (`max-w-3xl`), auth forms.
- Grids absorb width at `xl` (`sm:grid-cols-2 xl:grid-cols-4` for KPIs, rails widen).

## Responsive

- Page hero: `text-[2.4rem] sm:text-5xl/[4.2rem]`.
- KPI blocks: 2-across on phone, 4-across `lg`; shrink the number, hide sub-captions on mobile (`hidden sm:block`).
- Any horizontal flex row that can overflow gets `flex-wrap`.

## Voice & microcopy

Talk like a sharp SRE colleague, not a system: "All green, Calum.", "3 nodes
offline — take a look.", "Quiet so far. Add a node.", "It's live." Short.
Confident. Human. Lead with numbers.

## Do / Don't

- ✅ One coral CTA per screen; everything else navy/neutral.
- ✅ Eyebrow on every page; active nav always visible.
- ✅ Count-up numbers (`apps/app/src/components/count-up.tsx`), spring entrances `ease: [0.22, 1, 0.36, 1]`, 0.3–0.5s.
- ❌ No serif, no italics, no muted minimalism.
- ❌ No top nav bar — desktop sidenav, mobile tab bar. No hamburger menus.
- ❌ No raw Tailwind palette colours; tokens only.

## File map

- Tokens & utilities: `@swarmy/ui/src/styles.css` (shared by both apps).
- App globals + fonts + `@source`: `apps/app/src/styles/globals.css`.
- Shell: `apps/app/src/components/shell/{app-shell,sidenav,mobile-chrome}.tsx`, `components/theme-menu.tsx`.
- Primitives: `apps/app/src/components/{count-up,page-header,charts,status-pill}.tsx`.
- Data: components use `const trpc = useTRPC()` + `useQuery(trpc.x.queryOptions())` (see `skill("react-components")`).
- Auth: `apps/app/src/...` imports `@swarmy/auth/client` — never the package root in browser code.
