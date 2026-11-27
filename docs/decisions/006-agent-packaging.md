---
id: DR-006
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-006: Agent packaging

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Host binary under systemd; a container only as fallback (chosen)
- The agent in Docker

## Decision Outcome

Chosen option: Host binary under systemd; a container only as fallback, because can't repair Docker from inside it.

Turned down: The agent in Docker.
