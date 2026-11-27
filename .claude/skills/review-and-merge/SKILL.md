---
name: review-and-merge
description: Review a swarmy pull request against REVIEW.md, post the review on the PR, fix what it finds on Claude's own branches, then squash-merge once the merge gate passes. Use when asked to review, land or merge a PR, or to work through the open PRs. The founder has asked Claude to merge PRs that pass this gate (DR-056).
---

# Review and merge a pull request

`REVIEW.md` is the spec. This skill is the procedure, and the gate in step 5 is the only
path to a merge. Claude works through the founder's GitHub account (@virus2016), which
can't approve its own pull requests, so the review is a PR comment, not an approval.

## 1. Read the pull request

```bash
gh pr view <n> --json number,title,body,author,isDraft,baseRefName,headRefName,headRefOid,mergeable,files,commits
gh pr diff <n>
gh pr checks <n>
```

- Load the skill for each area the diff touches (the table in `AGENTS.md`) and read the
  Accepted records for those areas in `docs/RECORDS.md`.
- A stacked PR, whose base isn't `main`, waits until its base PR has merged.

## 2. Review

1. Run the `code-review` skill on the PR at `high` for correctness. Its reviewers read the
   code without your context, which matters most when you wrote the PR yourself.
2. Walk `REVIEW.md` section by section over the diff.
3. Sort every finding as blocking, fix first or note, as `REVIEW.md` defines them.

## 3. Post the review

Post one comment with `gh pr review <n> --comment --body-file <file>`:

- First line: `Review of <head SHA>: ready to merge`, `changes needed` or `needs the founder`.
- Each finding with its severity, `file:line`, the record or `REVIEW.md` section, and what
  goes wrong.
- One line on what was checked, including any check rerun as a flake.

## 4. Fix

- On a `claude/*` branch: fix blocking and fix-first findings on the branch. Commit with
  `git commit -s` and a `Refs:` trailer, push, then review the new commits (step 2) and
  post again.
- On anyone else's branch: don't push. Leave the review and stop.

## 5. The merge gate

Merge only when all of these hold:

1. The PR isn't a draft, its base is `main`, and `mergeable` is `MERGEABLE`.
2. Every check on the head commit has finished and passed; `skipping` counts as passed. If
   a failure looks unrelated to the diff, rerun the failed jobs once
   (`gh run rerun <run id> --failed`). If it passes, note the flake in the review. If it
   fails again, it's red.
3. The posted review covers the current head commit and leaves no blocking or fix-first
   finding open.
4. If the diff sets a record to Accepted or Rejected, or changes an Accepted record, the
   founder asked for exactly that, in this session or in a PR comment from @virus2016.
   Otherwise the verdict is `needs the founder`.
5. The author is the founder or a Claude session. Anyone else's PR needs the founder's go.

If any of these fails, don't merge. Say which one failed and what would clear it.

## 6. Merge

```bash
gh pr merge <n> --squash --subject "<PR title> (#<n>)"
```

- Never pass `--admin`, never merge a PR any way but squash, and never push to `main`.
- **Stacked PRs.** Retarget each open PR that was based on the merged branch, then merge
  `main` into it. Don't rebase and force-push: that rewrites history others may hold.

  ```bash
  gh pr edit <child> --base main
  git fetch origin && git switch <child branch>
  git merge --signoff origin/main   # keep both sides' changes when resolving conflicts
  git push origin <child branch>
  ```

  The child's squash merge flattens the merge commit away.

- Leave the merged branch in place; delete branches only when the founder asks.
- Finish with `git switch main && git pull --ff-only`.

## 7. Report

Tell the founder: the PR, the squash commit, the findings fixed or noted, and any flake that
was rerun.
