---
id: DR-010
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-010: Controller store

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Embedded SQLite, streamed to Garage with Litestream (reversed from PGlite on 24 Sep) (chosen)
- A Postgres service; PGlite

## Decision Outcome

Chosen option: Embedded SQLite, streamed to Garage with Litestream (reversed from PGlite on 24 Sep), because no database server, about 1 s of loss, a controller that can move.

Turned down: A Postgres service; PGlite.
