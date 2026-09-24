---
name: start-epic
description: Begin implementing a swarmy plan or roadmap item from the plans/ folder. Use when the user says "let's build <X>" / "start the <X> feature" / "work on the roadmap". Finds the plan or open item, reads the product doc and owning skill, confirms scope, and sets up a tracked plan.
---

# Start a plan or roadmap item

`plans/ROADMAP.md` is the list of what's still open (code-verified), grouped by
area. The only full design docs left in `plans/` are the ones still being built
(e.g. `epic-platform-upgrades.md`, `redesign-dashboard-2026-09.md`). Shipped
designs were deleted: their WHY lives in `docs/product/*.md`, their HOW in the
skills.

## Steps

1. **Locate the work** — match the ask to a `plans/<slug>.md` or a line in
   `plans/ROADMAP.md`. If unclear, list the ROADMAP sections and ask.

2. **Read, in this order:** the plan (if there is one); the area's product doc in
   `docs/product/` (its "Explicitly rejected" section lists the decisions you
   must not reopen); the owning skill that doc names (its invariants and file
   map). When a plan and a product doc disagree, the product doc wins.

3. **Confirm scope** — restate the first shippable slice in 3-5 bullets and
   confirm with the user before writing code.

4. **Set up tracking** — create tasks for the slice in build order. Most work
   follows `skill("add-feature-slice")` (Docker-first data → protocol → trpc →
   ui); a brief for someone else to build names the skill to load first, the
   exact files, an example of the pattern, and what "done" means.

5. **Respect the cross-cutting rules** in `docs/product/product-shape.md`
   ("Estate & stack behaviour"): org is the hard wall, one vault, the protocol
   only grows, everything audited, off by default and pluggable, one-command
   simple.

6. **Implement, test, commit** per slice using Conventional Commits
   (`feat(<scope>): …`) so semantic-release versions it
   (`skill("testing-conventions")`).

## When it ships

Fold any new decision into the product doc (or the skill, for a code
invariant), delete the ROADMAP line, and delete the plan once nothing in it is
still open — git keeps the history.
