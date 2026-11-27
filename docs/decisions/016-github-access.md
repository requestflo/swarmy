---
id: DR-016
status: accepted
date: 2026-11-27
decision-makers: founder
area: Deploys and builds
---

# DR-016: GitHub access

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- One GitHub App per install, short-lived tokens (chosen)
- Stored personal access tokens

## Decision Outcome

Chosen option: One GitHub App per install, short-lived tokens, because no long-lived tokens at rest.

Turned down: Stored personal access tokens.
