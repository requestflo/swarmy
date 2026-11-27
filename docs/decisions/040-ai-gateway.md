---
id: DR-040
status: accepted
date: 2026-11-27
decision-makers: founder
area: Access, observability and AI
---

# DR-040: AI gateway

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Provider keys encrypted in the controller (an exception to DR-005); routes mirror the providers; cost shown as an estimate (chosen)
- Docker secrets; a bespoke API; deploying LiteLLM

## Decision Outcome

Chosen option: Provider keys encrypted in the controller (an exception to DR-005); routes mirror the providers; cost shown as an estimate, because read on every request; migrating is a base-URL swap; LiteLLM needs 500 MB+.

Turned down: Docker secrets; a bespoke API; deploying LiteLLM.
