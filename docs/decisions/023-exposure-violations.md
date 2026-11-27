---
id: DR-023
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-023: Exposure violations

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Alert, and block the next deploy in enforce mode (chosen)
- Removing ports automatically

## Decision Outcome

Chosen option: Alert, and block the next deploy in enforce mode, because pulling a port can cut a database mid-write.

Turned down: Removing ports automatically.
