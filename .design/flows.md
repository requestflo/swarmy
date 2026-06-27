# Flows Ledger

> Routes at `/create` and `/actions/create` use the **Full-Screen Builder Layout**: no sidebar, no topbar, full viewport canvas. `AppShellContent` in `app-shell.tsx` detects these paths via `FULLSCREEN_ROUTES` and renders a bare `flex h-screen w-screen flex-col overflow-hidden` wrapper.

## Requester Flows

| Flow | Entry Point | Key Pages | Layout |
|------|-------------|-----------|--------|
| Create Request | `/create` | `CreateRequestPage` | Full-Screen Builder Layout (no sidebar) |
| Manage Requests | `/requests` | `RequestsPage`, `RequestDetailPage` | List Layout → Request Detail Layout |
| Review Inbox | `/inbox` | `InboxPage` | Inbox Layout |
| Connectors | `/connectors` | `ConnectorsPage` | Settings Layout |
| Actions | `/actions` | `ActionsPage` | List Layout |
| Create Action | `/actions/create` | `CreateActionPage` | Full-Screen Builder Layout (no sidebar) |
| Team | `/team` | `TeamPage` | Settings Layout |
| Billing | `/billing` | `BillingPage` | Settings Layout |
| Settings | `/settings` | `SettingsPage` | Settings Layout |

## Responder Flows

| Flow | Entry Point | Key Pages | Layouts |
|------|-------------|-----------|---------|
| Submit Response | Public token link | `ResponderPage` | `Public Form Layout` |

## Admin/System Flows

| Flow | Entry Point | Key Pages | Layouts |
|------|-------------|-----------|---------|
| Auth | `/login`, `/signup`, `/forgot-password`, `/reset-password` | `LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage` | `Public Form Layout` |

## Adding New Flows

When adding a route or page that starts a new flow:
1. Document the flow here.
2. Link the route file and page component.
3. Record the layout sequence using names from `layouts.md`.
