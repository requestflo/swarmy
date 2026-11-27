---
id: DR-043
status: accepted
date: 2026-11-27
decision-makers: founder
affects: BR-086
---

# DR-043: Terminals into services that mount secrets (finding M13)

## Context and Problem Statement

Today: Terminal permission alone gets in, and recordings can capture secret values. Affects BR-086.

## Considered Options

- Require secrets.read as well, and encrypt those recordings (chosen)
- Shell implies secrets
- Owners and admins only
- No recording
- Leave as is

## Decision Outcome

Chosen 27 Nov 2026: A shell into a service that mounts secrets needs terminal.open and secrets.read on it. Those sessions stay recorded, encrypted at rest with the controller key, and only holders of secrets.read may replay them.

Not built yet; the work is tracked in BR-086.
