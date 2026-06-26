---
name: start-epic
description: Begin implementing a swarmy roadmap epic from the plans/ folder. Use when the user says "let's build <epic>" / "start the <X> feature" / "work on the roadmap". Reads the epic's design doc, confirms scope, and sets up a tracked plan.
---

# Start a roadmap epic

The product roadmap lives in `plans/`. `plans/ROADMAP.md` has phasing +
dependencies; `plans/RECOMMENDATIONS.md` has the decided tech choices; each
`plans/<slug>.md` is a full design doc.

## Steps

1. **Locate the epic** — match the user's ask to a `plans/<slug>.md`. If unclear,
   list the epics from `plans/ROADMAP.md` and ask which one.

2. **Read the design doc fully**, plus `plans/RECOMMENDATIONS.md` for any locked
   tech decision it depends on, and the `## Dependencies` section — confirm
   prerequisite epics are done. If a dependency is missing, surface it.

3. **Confirm MVP scope** — restate the doc's "MVP vs later" first phase in 3-5
   bullets and confirm with the user before writing code. Epics are large; ship
   the MVP slice first.

4. **Set up tracking** — create tasks (TaskCreate) for the MVP slice, in build
   order. Most epics follow the `add-feature-slice` skill's shape (db → protocol →
   trpc → ui); invoke that skill for the implementation pattern.

5. **Respect cross-cutting rules** (from ROADMAP "Cross-cutting concerns"):
   org-scoping + ABAC, audit logging, agent protocol versioning, pluggability
   (the feature must be disableable), and "stays one-command simple".

6. **Implement, typecheck, commit** per slice using Conventional Commits
   (`feat(<scope>): …`) so semantic-release versions it.

## Note
Keep the plan doc updated: if the design changes during implementation, edit
`plans/<slug>.md` so it stays the source of truth.
