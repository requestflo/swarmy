---
id: DR-021
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-021: Edge proxy

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Caddy by default, plus none and cloudflared (owner, 24 Sep) (chosen)
- Traefik, nginx, HAProxy (removed Sep)

## Decision Outcome

Chosen option: Caddy by default, plus none and cloudflared (owner, 24 Sep), because protections, region rendering and the cert store are Caddy-only.

Turned down: Traefik, nginx, HAProxy (removed Sep).
