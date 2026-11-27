---
id: DR-025
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-025: Mesh

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Self-hosted NetBird run by the agent, Headscale as an option; swarmy is the OIDC provider (chosen)
- NetBird Cloud by default; Tailscale SaaS; plain WireGuard; Zitadel or Auth0

## Decision Outcome

Chosen option: Self-hosted NetBird run by the agent, Headscale as an option; swarmy is the OIDC provider, because a SaaS would hold your topology; the mesh must not depend on raft.

Turned down: NetBird Cloud by default; Tailscale SaaS; plain WireGuard; Zitadel or Auth0.
