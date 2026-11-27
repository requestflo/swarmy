---
id: DR-038
status: accepted
date: 2026-11-27
decision-makers: founder
area: Access, observability and AI
---

# DR-038: Identity and MFA

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Your own IdP plugs in and owns MFA; swarmy 2FA is optional (chosen)
- Keycloak, Authentik or Ory in front; mandatory swarmy 2FA

## Decision Outcome

Chosen option: Your own IdP plugs in and owns MFA; swarmy 2FA is optional, because a heavy identity service breaks one-command install.

Turned down: Keycloak, Authentik or Ory in front; mandatory swarmy 2FA.
