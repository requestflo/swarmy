---
id: DR-011
status: accepted
date: 2026-11-27
decision-makers: founder
area: Deploys and builds
---

# DR-011: App format

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Compose is canonical; swarmy.yaml compiles to it (chosen)
- A swarmy-only format

## Decision Outcome

Chosen option: Compose is canonical; swarmy.yaml compiles to it, because no lock-in; always exportable.

Turned down: A swarmy-only format.
