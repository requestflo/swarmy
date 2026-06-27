# Hooks Ledger

## Current App Hook Boundary

- `apps/web/src/hooks/` does not exist yet as a shared directory.
- App page state is currently kept inline inside page components or in page-local hook directories.
- `apps/web/src/components/create/hooks/` contains page-specific hooks for the request builder.
- If a hook is specific to one page layout, keep it beside that page in `apps/web/src/components/<page>/hooks/`.
- Promote a hook to `apps/web/src/hooks/` only after at least two app pages need the same behavior.

## Shared and Provider-Scoped Hooks

| Hook | Canonical Import Path | Source | Purpose |
|------|------------------------|--------|---------|
| `use-mobile` | `@requestflo/ui/hooks/use-mobile` | `packages/ui/src/hooks/use-mobile.ts` | Mobile viewport helper for shared UI |
| `use-toast`, `toast` | `@requestflo/ui/hooks/use-toast` | `packages/ui/src/hooks/use-toast.ts` | Toast store and imperative toast API |
| `useTheme` | `@requestflo/ui/components/theme-provider` | `packages/ui/src/components/theme-provider.tsx` | Read and update `light`, `dark`, or `system` theme |

## Page-Local Hooks

| Hook | Source | Purpose |
|------|--------|---------|
| `use-create-request-form` | `apps/web/src/components/create/hooks/use-create-request-form.ts` | Form state for the request builder |
| `use-generate-request` | `apps/web/src/components/create/hooks/use-generate-request.ts` | AI request generation logic |

## Drift Notes

- `useTheme` stays with the provider component because it depends on `ThemeProvider` context, so it is not listed under `packages/ui/src/hooks/`.

## Recommended Hook Locations

| Concern | Location |
|---------|----------|
| Page-specific state or orchestration | `apps/web/src/components/<page>/hooks/` |
| App-wide shared hooks | `apps/web/src/hooks/` |
| Shared UI primitive hooks | `packages/ui/src/hooks/` |
| Provider-scoped hooks | Beside the provider component in `packages/ui/src/components/` |
