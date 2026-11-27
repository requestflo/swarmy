---
id: DR-028
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-028: Database failover

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Promote only a copy proven caught up; otherwise hold for an admin (owner, 24 Sep) (chosen)
- Promote on seconds of lag; a consensus member

## Decision Outcome

Chosen option: Promote only a copy proven caught up; otherwise hold for an admin (owner, 24 Sep), because no silent data loss.

Turned down: Promote on seconds of lag; a consensus member.
