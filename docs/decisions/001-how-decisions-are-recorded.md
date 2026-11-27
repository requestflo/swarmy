---
id: DR-001
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-001: How decisions are recorded

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Numbered BR, NFR and DR records you accept, enforced by `AGENTS.md`, hooks and CI (chosen)
- Decisions as prose in product docs; owner decisions deleted after one release

## Decision Outcome

Chosen option: Numbered BR, NFR and DR records you accept, enforced by `AGENTS.md`, hooks and CI, because agents can't cite or check prose, and decisions get lost.

Turned down: Decisions as prose in product docs; owner decisions deleted after one release.
