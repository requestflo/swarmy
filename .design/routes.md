# Routes Ledger

## Route Tree

| Route File | URL | Shell | Layout | Product Surface | Page | Component File |
|------------|-----|-------|--------|-----------------|------|----------------|
| `routes/__root.tsx` | n/a | Global providers | Root providers | App foundation | `TRPCProvider`, `ThemeProvider`, `<Outlet />` | `routes/__root.tsx` |
| `routes/_app.tsx` | n/a | `AppShell` wrapper | `App Shell Layout` | App navigation | `AppShell` + `<Outlet />` | `components/app-shell.tsx` |
| `routes/_app/index.tsx` | `/` | `AppShell` | — | Redirect | `beforeLoad` redirects to `/inbox` | `routes/_app/index.tsx` |
| `routes/_app/inbox.tsx` | `/inbox` | `AppShell` | `Inbox Layout` | Response Inbox / Review / Approve | `InboxPage` | `components/inbox/inbox-page.tsx` |
| `routes/_app/requests.tsx` | `/requests` | `AppShell` | `List Layout` | Requests / Track | `RequestsPage` | `components/requests/requests-page.tsx` |
| `routes/_app/requests.$id.tsx` | `/requests/$id` | `AppShell` | `Request Detail Layout` | Request Details / Share / Track | `RequestDetailPage` | `components/requests/request-detail-page.tsx` |
| `routes/_app/create.tsx` | `/create` | No shell (fullscreen) | `Full-Screen Builder Layout` | AI Request Builder / Publish | `CreateRequestPage` | `components/create/create-request-page.tsx` |
| `routes/_app/connectors.tsx` | `/connectors` | `AppShell` | `Settings Layout` | Connectors / MCP Delivery | `ConnectorsPage` | `components/connectors/connectors-page.tsx` |
| `routes/_app/actions.tsx` | `/actions` | `AppShell` | `Settings Layout` | Actions / MCP Delivery | `ActionsPage` | `components/actions/actions-page.tsx` |
| `routes/_app/actions.create.tsx` | `/actions/create` | No shell (fullscreen) | `Full-Screen Builder Layout` | Create Action / AI Compose | `CreateActionPage` | `components/actions/create-action-page.tsx` |
| `routes/_app/billing.tsx` | `/billing` | `AppShell` | `Dashboard Layout` | Billing / Flow Usage | `BillingPage` | `components/billing/billing-page.tsx` |
| `routes/_app/settings.tsx` | `/settings` | `AppShell` | `Settings Layout` | Workspace Settings / API / Security | `SettingsPage` | `components/settings/settings-page.tsx` |
| `routes/_app/team.tsx` | `/team` | `AppShell` | `Settings Layout` | Team / Roles | `TeamPage` | `components/team/team-page.tsx` |
| `routes/login.tsx` | `/login` | No shell | `Public Form Layout` | Auth | `LoginPage` | `components/auth/login-page.tsx` |
| `routes/signup.tsx` | `/signup` | No shell | `Public Form Layout` | Auth | `SignupPage` | `components/auth/signup-page.tsx` |
| `routes/forgot-password.tsx` | `/forgot-password` | No shell | `Public Form Layout` | Auth | `ForgotPasswordPage` | `components/auth/forgot-password-page.tsx` |
| `routes/reset-password.tsx` | `/reset-password` | No shell | `Public Form Layout` | Auth | `ResetPasswordPage` | `components/auth/reset-password-page.tsx` |
| `routes/r.$requestId.tsx` | `/r/$requestId` | No shell | `Public Form Layout` | Respondent / Collect | `ResponderPage` | `components/responder/responder-page.tsx` |
| `routes/_app/preview.$tempId.tsx` | `/preview/$tempId` | `AppShell` | `Builder Layout` | Request Preview | Preview component | Inline route component |

## Product-Plan Route Gaps

| Product Surface | Status | Notes |
|-----------------|--------|-------|
| Connectors (real data) | Partial | `ConnectorsPage` shows brand tiles and connect CTAs; real `mcpServers.list` tRPC procedure + OAuth connect flow not yet wired |
| Create Action (real data) | Partial | Full-page flow built; connector picker uses stub `useConnectors()` returning `[]` until `mcpServers.list` lands |
| Replacement request flow | Partial | Inbox has `Request Replacement` action copy, but no documented respondent correction route or state yet |
| API docs / external API management | Partial | Settings has API key concepts, but no full API docs/admin route |
| Dashboard / Track surface | Deferred | `/` redirects to `/inbox`; dashboard revived in phase-3-operational-views when real data exists |

## Notes

- Keep `__root.tsx` for shared providers only.
- Keep `AppShell` in `apps/web/src/components/app-shell.tsx` until it becomes shared enough to move.
- Public routes must stay outside `AppShell`.
- Every new route should name its layout from `layouts.md` before implementation starts.
- Internal routes should reuse one of the existing named layouts before adding a new wrapper component.
- If a product-plan surface has no route, document the gap here and in `product-coverage.md` before adding one.
