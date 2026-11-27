---
id: DR-033
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-033: Controller backup passphrase

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Held by you; escrow is opt-in (chosen)
- Escrow under the main secret key by default

## Decision Outcome

Chosen option: Held by you; escrow is opt-in, because a key beside its backup is one loss from both.

Turned down: Escrow under the main secret key by default.
