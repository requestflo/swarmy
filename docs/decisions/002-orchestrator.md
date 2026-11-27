---
id: DR-002
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-002: Orchestrator

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Docker Swarm (chosen)
- Kubernetes, Nomad, k3s

## Decision Outcome

Chosen option: Docker Swarm, because simple and built into Docker; the product is shaped around it.

Turned down: Kubernetes, Nomad, k3s.
