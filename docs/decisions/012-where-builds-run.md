---
id: DR-012
status: accepted
date: 2026-11-27
decision-makers: founder
area: Deploys and builds
---

# DR-012: Where builds run

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- An agent command on your own builder nodes, rootless BuildKit (chosen)
- External CI; `docker build` on the main daemon

## Decision Outcome

Chosen option: An agent command on your own builder nodes, rootless BuildKit, because secrets and build minutes stay on your swarm; privileged builds on managers are dangerous.

Turned down: External CI; `docker build` on the main daemon.
