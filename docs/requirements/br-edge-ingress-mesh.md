# Business requirements: edge, ingress and mesh

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-043

- Status: Proposed
- Revision: 1
- Built: Needs live run

WHEN a DNS query reaches an edge node, THE SYSTEM SHALL answer with the nearest 1–2 healthy ingress nodes; with every region down it answers with all, never empty.

## BR-044

- Status: Proposed
- Revision: 1
- Built: Shipped

Every host swarmy serves resolves with no manual record; MX, TXT, CNAME, SRV and CAA records can be managed by hand.

## BR-045

- Status: Proposed
- Revision: 1
- Built: Shipped

DNS keeps answering from its last snapshot while the controller is down.

## BR-046

- Status: Proposed
- Revision: 1
- Built: Shipped

Registrar setup pins 2–4 nameserver nodes, shows glue and checks delegation; Cloudflare and Route 53 sync is offered to those keeping their nameservers.

## BR-047

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a route with automatic TLS is added, THE SYSTEM SHALL issue and serve a certificate with no setup, once the domain points at a swarmy edge.

## BR-048

- Status: Proposed
- Revision: 1
- Built: Needs live run

Several edges share one ACME account and certificate pool, serving from local disk first.

## BR-049

- Status: Proposed
- Revision: 1
- Built: Partial: the installer's own dashboard still uses sslip.io

WHEN a public app is first deployed, THE SYSTEM SHALL give it an HTTPS address; never for private, mesh or tunnel services or managed data.

## BR-050

- Status: Proposed
- Revision: 1
- Built: Shipped

A node with no public IP is reachable through a Cloudflare Tunnel set up by pasting a token.

## BR-051

- Status: Proposed
- Revision: 1
- Built: Shipped

Every live service is classified for exposure on each read; violations alert, enforce mode blocks the next deploy, and a live port is never removed.

## BR-052

- Status: Proposed
- Revision: 1
- Built: Shipped

Apps are isolated by default; "Connect apps" makes one private network per pair.

## BR-053

- Status: Proposed
- Revision: 1
- Built: Shipped

A node joins the WireGuard mesh with zero inbound ports using a single-use key that never touches disk; the default install runs NetBird inside swarmy.

## BR-054

- Status: Proposed
- Revision: 1
- Built: Needs live run

WHEN the mesh control-plane node dies, an admin can move it to another manager.

## BR-055

- Status: Proposed
- Revision: 1
- Built: Needs live run (expiry path)

People sign in through swarmy and reach only the app services they're granted, default deny; removal or expiry cuts access within 30 s.

## BR-056

- Status: Proposed
- Revision: 1
- Built: Not started

Multi-cluster: independent clusters with a switcher and shared sign-in at launch, a fleet hub later.
