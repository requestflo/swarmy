# Tailwind Ledger

## Sources

- `apps/web/src/index.css` is the only app Tailwind entrypoint.
- It imports `tailwindcss`, `tw-animate-css`, and `@requestflo/ui/styles/globals.css`.
- It scans both app code and shared UI code with:
  - `@source "../../../packages/ui/src"`

## Breakpoints

| Name | Width | Usage |
|------|-------|-------|
| Mobile | default | Single column, stacked |
| `sm` | 640px | 2-column grids, side-by-side filters |
| `lg` | 1024px | Master-detail, multi-column forms |
| `xl` | 1280px | Expanded panels, wider grids |

## Layout Conventions

| Pattern | Preferred Classes |
|---------|-------------------|
| App page scroller | `flex flex-col h-full` plus `flex-1 overflow-auto` |
| Wide overview wrapper | `mx-auto max-w-5xl`, `max-w-6xl`, or `max-w-[1400px]` with `px-6 py-6` |
| Focus page | `max-w-md` or `max-w-xl` with `mx-auto px-4 py-8` or `py-12` |
| Split review rail | `w-[380px] shrink-0 border-r` |
| Overview split | `grid grid-cols-12` with `col-span-8` and `col-span-4` |
| Studio split | `grid grid-cols-12` with `col-span-7` and `col-span-5` |
| Dense filter row | Search on the right, pills/selects on the left, usually under a header or card header |

## Shared Helper Classes

These come from `@requestflo/ui/styles/globals.css` and are safe to reuse:

- `heading-lg`, `heading-md`, `heading-sm`
- `label`, `body`, `caption`
- `metric-lg`, `metric-md`, `metric-sm`
- `data-row`, `status-dot`, `section-divider`, `active-state`
- `reveal-on-hover`, `reveal-target`
- `surface-glass-1`, `surface-glass-2`, `surface-glass-3`

## Custom / Project Conventions

- `min-h-[44px]` for touch targets
- `cn()` from `@requestflo/ui/lib/utils` for conditional classes
- `data-slot` attributes on shadcn components must stay intact
- Mobile-first: default styles are mobile, add `sm:`, `lg:` for larger

## Avoid

- Floats and absolute positioning for layout
- Arbitrary CSS when Tailwind utility exists
- Hardcoded pixel widths without responsive fallback
- Margin for sibling spacing (use `gap`)
- New undocumented utility names such as `panel`, `panel-header`, `panel-title`, or `data-table`
