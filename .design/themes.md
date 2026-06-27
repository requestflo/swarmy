# Themes Ledger

## Canonical Sources

- CSS tokens and utility classes live in `packages/ui/src/styles/globals.css`.
- Theme mode state lives in `packages/ui/src/components/theme-provider.tsx`.
- A pre-paint inline script in `apps/web/index.html` applies the persisted theme class + `color-scheme` before first render (no theme flash).
- Font files are imported in `apps/web/src/main.tsx`.

## Design Direction (2026-06 premium refactor)

The product is dark-first, calm, and confident. The look is built from four moves:

1. **Luminance layering, not boxes.** Sidebar (`--sidebar`, darkest) → canvas (`--background`) → surfaces (`--card`) → floating layers (`--popover`). Hairline borders (`border-border/60`) separate; `.surface-raised` / `.surface-overlay` add depth. Glass (`.surface-glass-*`) only on floating/sticky chrome.
2. **One confident accent.** `--primary` is an iris indigo (hue 275). It marks: the single most important action per screen, active nav, focus rings, key numbers. Everything else is neutral.
3. **Semantic status colors.** Request/response states use the `--status-*` tokens through `status-config.ts` (`getStatusConfig` / `getFloStatusConfig`) or Badge variants — never raw Tailwind palette colors.
4. **Quick, physical motion.** Entrances ≤250ms (`enterUp` / `enterFade`), springs for micro-interactions (`springSnap`). Never gate page visibility on a JS animation. No entrance animations on virtualized rows.

Typography: titles `text-xl font-semibold tracking-tight`; eyebrows `.label`; metrics `.metric-*` (font-light, tabular-nums); body `text-sm`; nothing below `text-xs` except kbd hints. Buttons and microcopy in sentence case, plain English.

## Theme Modes

- Dark mode is the default look; light mode is supported.
- `ThemeProvider` supports `light`, `dark`, and `system`; stores mode in `localStorage` under `requestflo-theme`; sets the root class and `color-scheme`.

## Typography

- Sans font: `Inter` · Mono font: `JetBrains Mono` (`@fontsource/*`, tokens `--font-sans` / `--font-mono`)

## Core Tokens

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--background` | `oklch(0.985 0.003 268)` | `oklch(0.137 0.012 270)` | Page canvas |
| `--foreground` | `oklch(0.21 0.018 268)` | `oklch(0.955 0.004 268)` | Primary text |
| `--card` | `oklch(1 0 0)` | `oklch(0.168 0.013 270)` | Card surfaces |
| `--popover` | `oklch(1 0 0)` | `oklch(0.193 0.014 270)` | Floating surfaces (menus, dialogs) |
| `--primary` | `oklch(0.54 0.19 275)` | `oklch(0.585 0.18 275)` | The single accent — iris indigo |
| `--primary-foreground` | `oklch(0.99 0 0)` | `oklch(0.99 0.002 275)` | Text on accent (white on iris) |
| `--secondary` | `oklch(0.965 0.005 268)` | `oklch(0.225 0.016 270)` | Secondary surfaces |
| `--muted` | `oklch(0.965 0.004 268)` | `oklch(0.215 0.015 270)` | Muted surfaces |
| `--muted-foreground` | `oklch(0.5 0.02 268)` | `oklch(0.63 0.018 268)` | Secondary text |
| `--accent` | `oklch(0.96 0.008 268)` | `oklch(0.225 0.018 272)` | Hover / selected backgrounds |
| `--destructive` | `oklch(0.6 0.21 25)` | `oklch(0.6 0.19 25)` | Destructive actions |
| `--border` | `oklch(0.925 0.005 268)` | `oklch(0.245 0.015 270)` | Hairline borders |
| `--input` | `oklch(0.91 0.006 268)` | `oklch(0.26 0.016 270)` | Input borders |
| `--ring` | `oklch(0.54 0.19 275)` | `oklch(0.62 0.17 275)` | Focus rings |
| `--radius` | `0.375rem` | `0.375rem` | Base radius — sharp, not over-rounded |

Sidebar tokens follow the same hues one step darker than `--background` (see `globals.css`).

## Status Token System

Five loop states, used via Tailwind color names (`text-status-review`, `bg-status-approved/10`, …):

| Token | Meaning | Used for |
|-------|---------|----------|
| `--status-pending` | Neutral / waiting | Drafts, paused, pending |
| `--status-validating` | AI is analyzing | Incoming responses pre-analysis |
| `--status-review` | Needs a human | "Ready to review", attention counts |
| `--status-approved` | Approved / completed | Approved responses, completed requests |
| `--status-rejected` | Rejected / failed | Rejected responses, validation failures |
| `--status-delivered` | Delivered via actions | Post-approval delivery |

Plus `--success` / `--warning` for generic semantics. **Never** use raw palette colors (`amber-600`, `emerald-500`, `bg-[#hex]`) in app code. `text-warning-foreground` is an *on-warning-surface* color — never standalone text.

All request/response status styling flows through `apps/web/src/components/requests/status-config.ts` (`getStatusConfig`, `getFloStatusConfig`) and the Badge variants `success | warning | accent | muted | destructive`.

## Shared Utility Classes (globals.css)

| Class | Purpose |
|-------|---------|
| `.heading-lg/md/sm`, `.label`, `.body`, `.caption` | Type hierarchy |
| `.text-display` | Hero typography (font-light tracking-tight) |
| `.metric-lg/md/sm` | Numbers: font-light + tabular-nums |
| `.surface-raised` | Card depth (inset top-light + ambient shadow) |
| `.surface-overlay` | Floating depth (popovers, sticky bars) |
| `.surface-glass-1/2/3` | Glass; floating/sticky chrome only |
| `.data-row` | Dense list rows with hairline separators |
| `.status-dot` | 8px status dot |
| `.reveal-on-hover` / `.reveal-target` | Progressive disclosure |

## Color Function Rule

Tokens are raw `oklch()` values. `hsl(var(--token))` is **invalid CSS** and renders nothing. Use `var(--token)` directly, or `color-mix(in oklab, var(--token) N%, transparent)` for alpha.

## Motion Tokens (`@requestflo/ui/lib/motion`)

`springSoft` / `springSnap` / `springSlow`, `staggerChildren` / `staggerFast`, `durationFast(0.15)` / `durationBase(0.25)` / `durationSlow(0.4)`, `easeOut`, and entrance presets `enterUp` / `enterFade`. Rules: entrances ≤250ms; transform-only when gating could hide content; respect `prefers-reduced-motion`.
