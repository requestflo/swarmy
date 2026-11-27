---
id: DR-030
status: accepted
date: 2026-11-27
decision-makers: founder
area: Data and resilience
---

# DR-030: Volumes

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Engine-native copies and moves; ext4 only, never auto-format (owner, 25 Sep) (chosen)
- Ceph, Gluster, Longhorn, DRBD; XFS; LVM spanning

## Decision Outcome

Chosen option: Engine-native copies and moves; ext4 only, never auto-format (owner, 25 Sep), because nothing trustworthy fits 1 GB servers.

Turned down: Ceph, Gluster, Longhorn, DRBD; XFS; LVM spanning.
