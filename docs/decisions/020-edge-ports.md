---
id: DR-020
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-020: Edge ports

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Host mode (chosen)
- The swarm routing mesh

## Decision Outcome

Chosen option: Host mode, because the routing mesh sends traffic to any node and loses locality.

Turned down: The swarm routing mesh.
