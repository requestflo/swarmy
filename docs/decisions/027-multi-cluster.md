---
id: DR-027
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-027: Multi-cluster

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Independent clusters at launch, a fleet hub later (chosen)
- One controller for many swarms

## Decision Outcome

Chosen option: Independent clusters at launch, a fleet hub later, because contradicts Docker as truth and lowers availability.

Turned down: One controller for many swarms.
