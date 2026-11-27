---
id: DR-009
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-009: Node recovery

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- The same install line, plus a claim a person approves by fingerprint (chosen)
- A separate recovery command; auto-approved claims

## Decision Outcome

Chosen option: The same install line, plus a claim a person approves by fingerprint, because one command to remember under stress; claims are unauthenticated.

Turned down: A separate recovery command; auto-approved claims.
