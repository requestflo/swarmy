---
id: DR-056
status: accepted
date: 2026-11-27
decision-makers: founder
---

# DR-056: Claude reviews and merges pull requests

## Context and Problem Statement

Pull requests wait for the founder to merge them, and `main` has no branch protection, so
nothing but the person merging checks a change before it lands. On 27 Nov 2026 the founder
asked for Claude to review each pull request against a written spec and merge it when it
passes.

Claude works through the founder's GitHub account. GitHub doesn't let an account approve its
own pull request, so a required approval, a code-owner review included, would block every
merge Claude makes.

## Considered Options

- Claude reviews against `REVIEW.md` and squash-merges when a written gate passes (chosen)
- The founder reviews and merges every pull request
- Claude Approvals on GitHub, where Claude approves as an app and branch protection requires
  its check (needs a Claude Team or Enterprise plan)
- Branch protection that requires a code-owner review

## Decision Outcome

Chosen 27 Nov 2026: Claude reviews and merges, because work keeps moving while the gate
keeps the founder's calls with the founder.

- `REVIEW.md` is the spec, and the `review-and-merge` skill is the procedure.
- Claude merges only when the pull request isn't a draft and targets `main`, every CI check
  on its head commit passed, a review of that commit is posted on the pull request with no
  open blocking finding, and the author is the founder or a Claude session.
- A pull request that sets a record to Accepted or Rejected, or changes an Accepted record,
  waits for the founder's word (DR-001).
- Merges are squash merges with the pull request title as the subject; never `--admin`,
  never a direct push to `main`.

Revisit when a second person joins, or when the org's Claude plan offers Claude Approvals.
