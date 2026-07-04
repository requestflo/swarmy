# docs/product — product thinking, decisions, and vision

This folder holds **product-level design documents**: the "why it should feel this
way" thinking that sits above any single epic or PR. It is the durable home for
the vision conversations that otherwise live only in chat threads.

How it relates to the other folders:

- **`docs/product/`** (here) — what the product IS and how it should feel to the
  person running swarmy. Written for humans first; survives implementation churn.
  When a decision here changes, the change is deliberate and discussed.
- **`plans/`** — epic-scoped implementation designs and the roadmap. Plans may be
  superseded; when a plan and a product doc disagree, **the product doc wins** and
  the plan gets a supersession note.
- **`.claude/skills/`** — operational instructions for working IN the codebase
  (conventions, invariants, file maps). Skills reference product docs for the
  "why"; product docs reference skills for the "how".

Documents:

- [`edge-network.md`](./edge-network.md) — the global edge: geo-DNS, nameserver
  nodes, region-aware Caddy routing, and the mesh that ties it together.
