---
id: DR-018
status: accepted
date: 2026-11-27
decision-makers: founder
area: Deploys and builds
---

# DR-018: Platform upgrades

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- An admin clicks; opt-in automatic patch releases in a window; releases signed with a key checked offline (chosen)
- Automatic everything; Sigstore keyless; a GitHub-only feed

## Decision Outcome

Chosen option: An admin clicks; opt-in automatic patch releases in a window; releases signed with a key checked offline, because nothing changes without an admin; air-gapped estates must upgrade.

Turned down: Automatic everything; Sigstore keyless; a GitHub-only feed.
