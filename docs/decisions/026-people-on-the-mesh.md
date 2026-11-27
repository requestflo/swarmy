---
id: DR-026
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-026: People on the mesh

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- A per-app access router and DNS zone, default deny (chosen)
- Node mesh IPs; one router on every network

## Decision Outcome

Chosen option: A per-app access router and DNS zone, default deny, because keeps the network wall, least privilege per port.

Turned down: Node mesh IPs; one router on every network.
