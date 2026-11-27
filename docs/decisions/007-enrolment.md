---
id: DR-007
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-007: Enrolment

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Pasted one-liner; the agent dials out (chosen)
- Controller pushes over SSH, Ansible or cloud-init

## Decision Outcome

Chosen option: Pasted one-liner; the agent dials out, because no node credentials on the controller; works behind NAT.

Turned down: Controller pushes over SSH, Ansible or cloud-init.
