---
id: DR-008
status: accepted
date: 2026-11-27
decision-makers: founder
area: Platform
---

# DR-008: Installer

## Context and Problem Statement

This was already decided in the code when DR-001 started the record system. It was written down on 2026-11-27 from the product docs' "Explicitly rejected" sections and dated owner decisions, and accepted the same day.

## Considered Options

- POSIX sh, token in the environment, pinned loader and binary, HTTPS only with a signed manifest (chosen)
- Bash; token in the URL; plain HTTP

## Decision Outcome

Chosen option: POSIX sh, token in the environment, pinned loader and binary, HTTPS only with a signed manifest, because busybox lacks Bash, URLs leak into logs, a MITM would get root.

Turned down: Bash; token in the URL; plain HTTP.
