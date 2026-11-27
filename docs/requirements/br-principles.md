# Business requirements: product principles

The promises every swarmy feature keeps, taken from `docs/product/product-shape.md`. All are already true in the code.

## BR-001 · Your own cloud, on your own hardware

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

VPSs, home servers, office boxes and bare metal get cloud-shaped layers (private mesh, protected edge, tunnels, object storage, managed databases with point-in-time restore, geo-DNS, backups, governance) with no cloud-provider lock-in.

## BR-002 · No required swarmy cloud

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

The first node bootstraps everything. Your cloud never depends on ours.

## BR-003 · Docker is the source of truth

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Config lives on Docker labels, configs and secrets. Delete swarmy and every stack keeps running on plain `docker stack deploy`.

## BR-004 · The controller never reaches in

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Nodes need zero inbound ports. The agent dials out, and no feature may add a path where the controller opens a socket to a node.

## BR-005 · The repairer lives outside what it repairs

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

The agent is a host binary, not a container, so it can fix Docker when Docker is broken.

## BR-006 · Off by default, pluggable, individually disableable

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

A feature that can't be cleanly turned off doesn't ship.

## BR-007 · Everything is audited

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Guardrail blocks and overrides, drills, access grants, deploy decisions and role changes all land in the audit log.

## BR-008 · Safety is the product

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Health-gated deploys with automatic rollback, production guardrails, scheduled safe drills, exposure violations that alert but never silently change ports, and image signing with CVE gates.

## BR-009 · The org is a hard wall

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Everything is keyed by org with no path between orgs. A hosted tier assumes hostile co-tenants.

## BR-010 · One vault; secrets never come back

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Every stored credential is hashed or encrypted under one key and never returned to a client.

## BR-011 · The protocol only grows

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

A new capability is a new message type or an optional field, negotiated at the handshake. The agent is never rewritten per feature.

## BR-012 · One-command simple

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Enrol a node with one pasted line, deploy a template in one click, point a domain and get TLS automatically.

## BR-013 · Two altitudes

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

The estate (everything you own, on one screen) and the app workspace (one app, operated). Every estate card opens the workspace that owns it.

## BR-014 · Plain words at three depths

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Every screen reads at Summary, Controls and Code, with a sentence headline and one coral action. Code shows the exact swarmy.yaml, CLI or REST call for what is on screen.

## BR-015 · Two front doors, one service layer

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

Everything the dashboard does is also in the REST API, the Go, Python and TypeScript SDKs and the Terraform provider, through the same org-scoped services.

## BR-016 · A public demo with no backend

- Status: Accepted
- Revision: 1
- Accepted: 2026-11-27

The whole app runs from seeded data in the browser, with no database, auth or agents.
