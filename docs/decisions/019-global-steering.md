---
id: DR-019
status: accepted
date: 2026-11-27
decision-makers: founder
area: Edge and network
---

# DR-019: Global steering

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- swarmy-dns, authoritative, deciding per query (chosen)
- Anycast/BGP; region subdomains; CoreDNS zone files

## Decision Outcome

Chosen option: swarmy-dns, authoritative, deciding per query, because works on any VPS with no restarts.

Turned down: Anycast/BGP; region subdomains; CoreDNS zone files.
