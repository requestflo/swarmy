---
id: DR-046
status: accepted
date: 2026-11-27
decision-makers: founder
affects: BR-037
---

# DR-046: Dashboard writes to git

## Context and Problem Statement

Today: Read-only; every "Open PR" on the boards is hidden. Affects BR-037.

## Considered Options

- Pull requests only (chosen)
- Direct commits
- A separate git.write permission
- Staying read-only

## Decision Outcome

Chosen 27 Nov 2026: Pull requests only. Swarmy pushes a branch and opens a PR, never commits to the default branch. Anyone with service.configure on the app may trigger one. GitHub first (contents: write; existing installs re-approve once), GitLab and Gitea after; commits come from the swarmy app with the user as Co-authored-by.

Not built yet; the work is tracked in BR-037.
