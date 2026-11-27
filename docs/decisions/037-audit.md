---
id: DR-037
status: accepted
date: 2026-11-27
decision-makers: founder
area: Access, observability and AI
---

# DR-037: Audit

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- One audit writer that also records every denial (chosen)
- Separate writers; auditing permits only

## Decision Outcome

Chosen option: One audit writer that also records every denial, because two writers forget rows; denials are the signal.

Turned down: Separate writers; auditing permits only.
