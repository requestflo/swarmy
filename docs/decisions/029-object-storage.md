---
id: DR-029
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-029: Object storage

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Garage (chosen)
- MinIO, Ceph, SeaweedFS

## Decision Outcome

Chosen option: Garage, because replicates across small, spread-out, mixed nodes in one binary.

Turned down: MinIO, Ceph, SeaweedFS.
