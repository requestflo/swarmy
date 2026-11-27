---
id: DR-039
status: accepted
date: 2026-11-27
decision-makers: founder
area: Access, observability and AI
---

# DR-039: Telemetry

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- One collector and one ClickHouse with swarmy's own UI; injected by env and labels only (chosen)
- Jaeger or Grafana; SigNoz; sidecars or image rewrites

## Decision Outcome

Chosen option: One collector and one ClickHouse with swarmy's own UI; injected by env and labels only, because one design system, no second login, a clean opt-out.

Turned down: Jaeger or Grafana; SigNoz; sidecars or image rewrites.
