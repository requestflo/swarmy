# Product Coverage Ledger

This file cross-references the product plan with the current web routes, layouts, and design docs. Use it before adding new pages so missing product surfaces are explicit instead of solved by inventing ad hoc layouts.

## Product Loop Coverage

| Product Stage | Required Experience | Route / Page | Layout | Coverage | Notes |
|---------------|---------------------|--------------|--------|----------|-------|
| Describe | Plain-English AI request builder | `/create` / `CreateRequestPage` | `Builder Layout` | Covered in design | Needs real implementation coverage checked separately |
| Generate | AI creates fields, validation, review settings, suggested actions | `/create` / `CreateRequestPage` | `Builder Layout` | Partial | UI shows generated fields/actions; product plan expects MCP-backed suggestions |
| Review | User edits structure and previews respondent page | `/create`, `/requests/$id` | `Builder Layout`, `Request Detail Layout` | Covered in design | Preview rail exists in builder |
| Publish | Secure share link, copy link, QR code | `/create`, `/requests/$id` | `Builder Layout`, `Request Detail Layout` | Covered in design | Needs route/backend verification outside design docs |
| Share | Link, tracked links, MCP-backed distribution | `/requests/$id` | `Request Detail Layout` | Partial | Distribution channels are presentational; per-recipient tracking not its own surface yet |
| Collect | Respondent submits fields/files from public link | `/r/$requestId` / `ResponderPage` | `Public Form Layout` | Covered in design | Replacement/correction path is not documented yet |
| Validate | AI summary, validation results, confidence | `/inbox`, `/requests/$id` | `Inbox Layout`, `Request Detail Layout` | Covered in design | Current pages use mock/presentational validation states |
| Review | Inbox review with extracted data, files, notes | `/inbox` / `InboxPage` | `Inbox Layout` | Covered in design | This is the operational center and should stay central |
| Approve | Approve, reject, flag, replacement request | `/inbox` / `InboxPage` | `Inbox Layout` | Partial | UI actions exist; replacement request flow needs route/state design |
| Deliver | Approved responses trigger MCP actions | `/actions`, `/actions/create`, `/connectors`, `/requests/$id` | `Full-Screen Builder Layout`, `Settings Layout`, `Request Detail Layout` | Partial | UI flow built; real connector list and field mapping still needed; test logs and retry workflows not yet implemented |
| Track | Requests, activity, failures, usage | `/inbox`, `/requests`, `/billing` | `Inbox Layout`, `List Layout`, `Dashboard Layout` | Covered in design | No standalone dashboard yet; attention/failure/usage surfaces planned for phase-3 |

## Product Surface Coverage

| Product Plan Surface | Route(s) | Layout | Coverage | Design Notes |
|----------------------|----------|--------|----------|--------------|
| Dashboard | `/` (redirect → `/inbox`) | — | Deferred | No standalone dashboard yet; `/` redirects to `/inbox`; phase-3-operational-views will revive when real data exists |
| Create Request | `/create` | `Full-Screen Builder Layout` | Covered | Keep plain-English builder, generated structure, preview, publish, and Flow estimate in one guided layout |
| Requests | `/requests` | `List Layout` | Covered | Use operational list, not marketing cards; show status, progress, owner, due, attention, Flow usage |
| Request Details | `/requests/$id` | `Request Detail Layout` | Covered | Required tabs: Overview, Structure, Share & Delivery, Responses, Actions, Activity |
| Inbox | `/inbox` | `Inbox Layout` | Covered | Must stay worklist + detail + approve/reject/replacement action bar |
| Actions | `/actions`, `/actions/create` | `Settings Layout`, `Full-Screen Builder Layout` | Partial | Card grid + AI full-page create flow built; real connector list wiring still needed |
| Connectors | `/connectors` | `Settings Layout` | Partial | Brand tile grid + custom CTA built; real OAuth connect flow and `mcpServers.list` tRPC not yet wired |
| Billing / Flow Usage | `/billing` | `Dashboard Layout` | Covered | Plan names and Flow allowances in UI need alignment with product plan: Free 5, Starter 200, Growth 600, Pro 1500 |
| Team | `/team` | `Settings Layout` | Covered | Team members, invites, roles |
| Settings | `/settings` | `Settings Layout` | Partial | Covers account/security/API/webhooks/integrations |
| Auth | `/login`, `/signup`, `/forgot-password`, `/reset-password` | `Public Form Layout` | Covered | Raw controls are current drift; future work should standardize with shared primitives |
| Respondent Page | `/r/$requestId` | `Public Form Layout` | Partial | Submit flow exists; replacement/correction and richer validation feedback need design detail |

## Product Gaps To Track

| Gap | Product Source | Suggested Layout | Why It Matters |
|-----|----------------|------------------|----------------|
| `mcpServers.list` tRPC procedure | Phase 2 MCP Delivery | Connector picker (Create Request + Create Action) | Without real connector list, action picker always shows stub; AI generation cannot inject real connectors |
| Field mapping UI | Phase 2 MCP Delivery | `Request Detail Layout` or `Builder Layout` section | Actions must map request/response fields into MCP tool inputs |
| Action run history and retry detail | Phase 2 MCP Delivery | `Request Detail Layout` actions tab or `List Layout` logs | Failures must be visible and repairable |
| OAuth / connect flow for Connectors | Phase 2 MCP Delivery | `Settings Layout` | `ConnectorsPage` connect CTA is optimistic mock; real URL + auth handling needed |
| Replacement request flow | Core loop and respondent experience | `Inbox Layout` plus `Public Form Layout` correction state | Review is incomplete without asking for corrected information |
| Plan/pricing alignment | Product pricing plan | `Dashboard Layout` billing page | Current UI examples do not match final Flow allowances and plan names |
| Dashboard / Track surface | Phase 3 Operational Views | `Dashboard Layout` at `/` | Deferred; revive when real data exists for attention, failures, usage |

## Guardrails From Product Plan

- RequestFlo is a workflow product, not a form builder.
- Share links and inbox review stay central.
- Sensitive workflows default to manual review before delivery.
- Delivery happens through MCP actions unless a bespoke integration is explicitly scoped.
- Flow usage must be visible before users are surprised.
