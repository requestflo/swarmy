---
id: DR-035
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-035: Drills

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Restore into a throwaway cluster and show measured RPO and RTO (chosen)
- Restoring over live data; an "HA" badge

## Decision Outcome

Chosen option: Restore into a throwaway cluster and show measured RPO and RTO, because a drill you're afraid to run isn't a drill.

Turned down: Restoring over live data; an "HA" badge.
