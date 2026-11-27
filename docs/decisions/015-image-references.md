---
id: DR-015
status: accepted
date: 2026-11-27
decision-makers: founder
area: Deploys and builds
---

# DR-015: Image references

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Deploy by `@sha256` digest (chosen)
- Floating tags

## Decision Outcome

Chosen option: Deploy by `@sha256` digest, because tags break rollback and cleanup pinning.

Turned down: Floating tags.
