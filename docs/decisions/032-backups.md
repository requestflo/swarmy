---
id: DR-032
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-032: Backups

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- restic, with one destination type for volumes, databases and the controller (chosen)
- kopia, borg; one system per data type

## Decision Outcome

Chosen option: restic, with one destination type for volumes, databases and the controller, because one static binary, S3-first, restorable by hand.

Turned down: kopia, borg; one system per data type.
