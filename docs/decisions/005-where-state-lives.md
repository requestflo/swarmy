---
id: DR-005
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-005: Where state lives

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Docker labels, configs and secrets; the database holds only swarmy's identity, access, audit and history (chosen)
- A database mirroring swarm state (incl. a production flag column)

## Decision Outcome

Chosen option: Docker labels, configs and secrets; the database holds only swarmy's identity, access, audit and history, because mirrors drift; labels survive losing the database.

Turned down: A database mirroring swarm state (incl. a production flag column).
