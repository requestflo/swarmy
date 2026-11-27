---
id: DR-022
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-022: Certificates

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- Node-local first, a Garage replica, one shared ACME account (chosen)
- Per-node certs; Garage only; Redis

## Decision Outcome

Chosen option: Node-local first, a Garage replica, one shared ACME account, because avoids issuing N times and a reboot deadlock.

Turned down: Per-node certs; Garage only; Redis.
