---
name: delegation
description: How to delegate exploration, planning, and building across coding agents — the default model-per-role matrix for Claude Code (Sonnet explores, Fable plans + does all UI, Opus builds), Codex (GPT-5.6 `sol` plans on high/xhigh, `terra` builds, `luna` explores), and OpenCode (GLM-5.2 plans, Minimax executes). Load whenever spawning subagents or shelling out to `codex`/`opencode` to explore, plan, or build. If the user does NOT name a tool/model/approach, fall back to this matrix. If the user names a specific model (e.g. "use fable"), use ONLY that model and ignore the matrix.
metadata:
  auto_invoke:
    - delegate
    - delegation
    - subagent
    - explore
    - codex
    - opencode
    - sol
    - terra
    - luna
    - minimax
    - glm
    - fable
---

# Delegation: which model does what

This skill decides **which model does exploration, which does planning, and which does building** when work is delegated to a coding agent. It covers three tools — **Claude Code**, **Codex** (GPT), and **OpenCode** — and the override rules for when the user says something more specific.

## Decision order (read this first)

Apply these in order. The first one that matches wins.

1. **User named a specific model** → use ONLY that model, focus the whole task on it, ignore the matrix below.
   - "use fable" → run the task on the `fable` model. "do this with sonnet" → sonnet. "opus for all of it" → opus.
   - This is a hard override. Do not silently split the work across other models.
2. **User named a specific tool** (Claude Code / Codex / OpenCode) but not the model → use that tool's column in the matrix, mapping each phase (explore/plan/build) to the model below.
3. **User named nothing** (just "do X", "build Y", "figure out Z") → this is the default. Use the matrix. Default tool is **Claude Code** unless context says otherwise.

> The matrix is the *fallback*, not the *default preference*. Only reach for it when the user hasn't told you how they want the work done. When they have, do exactly what they said.

## The default matrix

| Phase | Claude Code | Codex (GPT) | OpenCode |
|-------|-------------|-------------|----------|
| **Explore / research** | Sonnet | `luna` | (use planner) |
| **Plan / define the work** | Fable | GPT-5.6 `sol` @ **high** or **extra-high** reasoning | GLM-5.2 |
| **Build / implement / deliver** | Opus | GPT-5.6 `terra` | Minimax |
| **UI work** | Fable | `terra` | Minimax |

Model/profile names for Codex (`sol`/`terra`/`luna`) and OpenCode (GLM-5.2, Minimax) are the user's locally configured models/profiles — the mapping below is the intent; resolve exact IDs from their `codex`/`opencode` config.

---

## Claude Code — Sonnet explores, Opus builds

The canonical flow: **Sonnet explores → Fable plans → Opus builds.** Cheap-and-broad discovery feeds a Fable-authored plan, which feeds premium-and-precise implementation. **UI work goes to Fable** — both planning it and building it.

### 1. Explore with Sonnet

Spawn read-only Sonnet subagents to map the codebase, find the files, and report conclusions — not to build. Prefer the `Explore` agent type.

```
Agent(
  subagent_type: "Explore",
  model: "sonnet",
  description: "Map the auth flow",
  prompt: "Report back: every file in the publicProcedure→protectedProcedure→
           orgProcedure chain, where writeAudit is called, and the exact
           signature of abacProcedure. Read excerpts, don't audit. Do not edit."
)
```

Run several in one message when the searches are independent — they execute concurrently.

### 2. Plan with Fable

Hand the exploration findings to **Fable** to produce the build plan — scope, decomposition, files, order, acceptance criteria. **Any UI work is Fable's job end-to-end** — it plans *and* builds the UI (Fable is the UI model, not just the planner).

```
Agent(
  model: "fable",
  description: "Plan the <X> feature",
  prompt: "Given <exploration findings>, produce a build plan: files to touch,
           order, risks, acceptance criteria. For UI, also design the surface."
)
```

### 3. Build with Opus — ultra-premium, very clear prompts

(Non-UI implementation. UI stays on Fable per step 2.)


When you delegate the *build* to Opus, the prompt must be **ultra-premium: example code, specific direction, exact files, and acceptance criteria.** A vague Opus prompt wastes the most capable model. Never hand Opus "go implement the thing" — hand it a spec it could not misread.

Every Opus build brief MUST include:

- **Exact files to touch** (`file_path:line` where possible) and which skill to load first (e.g. "load `add-feature-slice`").
- **Example code** — a concrete snippet showing the pattern/shape you want, even if illustrative. Show, don't describe.
- **Specific direction** — the approach, not just the goal. Name the function, the type, the layer.
- **Acceptance criteria** — what "done" looks like (tests pass, typecheck clean, behavior observable).
- **Guardrails** — what NOT to do (don't add a DB column, don't touch the protocol, follow the existing idiom).

**Template:**

```
Agent(
  model: "opus",
  description: "<verb + object, 3-5 words>",
  prompt: """
  Load the `<skill>` skill first.

  GOAL: <one sentence>.

  FILES:
  - packages/trpc/src/routers/foo.ts — add the `bar` procedure
  - packages/db/schema/foo.prisma:42 — the Foo model it reads

  PATTERN — follow this exact shape (see baz.ts for the real one):
  ```ts
  export const barRouter = orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      // ... like fooRouter.get, but returning Bar
    })
  ```

  DIRECTION: reuse the existing `getBarService`; do not add a new service.
  Wire it into the router index the same way `foo` is wired.

  DONE WHEN: `bun test` passes, typecheck is clean, and the /bar route
  returns the record. Report what you changed.

  DO NOT: add a Prisma column, change the protocol, or invent new patterns.
  """
)
```

If you are already running as Opus, you can do the build inline — but hold yourself to the same bar: gather the example code and exact files (via Sonnet exploration) *before* you start writing.

---

## Codex — `sol` plans, `terra` builds, `luna` explores

Shell out to the `codex` CLI. Map the phase to the model/profile:

- **Explore** → `luna`
- **Plan / define the work** → `sol`, at **high** or **extra-high** reasoning effort. `sol` does the up-front thinking: scoping, decomposition, the full plan. Give it room.
- **Build** → `terra`, handed `sol`'s plan.

```bash
# Plan the whole thing on sol at high reasoning
codex exec -m sol -c model_reasoning_effort="high" \
  "Plan the implementation of <X>. Produce a step-by-step build plan:
   files to touch, order, risks, and acceptance criteria."

# For the hardest problems, push reasoning to extra-high
codex exec -m sol -c model_reasoning_effort="xhigh" "<hard planning task>"

# Build against sol's plan on terra
codex exec -m terra "Implement the following plan exactly: <paste sol's plan>"

# Explore / recon on luna
codex exec -m luna "Find where <thing> is defined and how it's used. Report only."
```

`sol` = the planner (high/xhigh), `terra` = the builder, `luna` = the scout. Exact model IDs come from the user's Codex config; the flags above are the shape.

---

## OpenCode — GLM-5.2 plans, Minimax executes

Shell out to the `opencode` CLI. Two roles:

- **Plan** → GLM-5.2 does the scoping and the plan.
- **Execute / deliver** → Minimax does the building and ships it.

```bash
# Plan on GLM-5.2
opencode run -m <glm-provider>/glm-5.2 \
  "Plan the implementation of <X>: files, steps, acceptance criteria."

# Execute + deliver on Minimax
opencode run -m <minimax-provider>/minimax \
  "Implement this plan and deliver it: <paste GLM's plan>"
```

Resolve `<glm-provider>` / `<minimax-provider>` from the user's `opencode.json` / provider config. GLM-5.2 = the planner, Minimax = the executor/deliverer.

---

## Quick reference

- **No tool/model named** → Claude Code + matrix: **Sonnet explores → Fable plans → Opus builds** (Opus brief = example code + exact files + acceptance criteria). **UI = Fable, plan and build.**
- **"use codex"** → `sol` plans (high/xhigh) → `terra` builds; `luna` explores.
- **"use opencode"** → GLM-5.2 plans → Minimax executes.
- **"use fable"** (or any named model) → that model only, whole task, ignore the matrix.
- **Prompting rule for the premium builder (Opus / terra / Minimax):** never send a vague brief — always example code, exact files, specific direction, and what "done" means.
