---
id: DR-036
status: accepted
date: 2026-11-27
decision-makers: founder
area: Access, observability and AI
---

# DR-036: Authorisation

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Attribute-based policy with role as one attribute; built-in JSON engine, optional Cedar; destructive actions gated (owner, 24 Sep) (chosen)
- A fixed role matrix; SpiceDB, OpenFGA, OPA

## Decision Outcome

Chosen option: Attribute-based policy with role as one attribute; built-in JSON engine, optional Cedar; destructive actions gated (owner, 24 Sep), because can't otherwise express "operator on this app"; no extra network hop.

Turned down: A fixed role matrix; SpiceDB, OpenFGA, OPA.
