# Reviewing a swarmy pull request

This is the review spec: what a reviewer, a person or Claude, checks before a pull request
merges. `AGENTS.md` holds the rules; this file says how to check a change against them.
The procedure that ends in a merge is the `review-and-merge` skill.

Report a finding only when the change breaks a check below or has a real bug. Give the file
and line, the record or section it breaks, and what goes wrong. Skip style that Prettier,
commitlint or the type checker already catch.

## 1. Records (DR-001)

- The change keeps every Accepted record that covers the files it touches. A conflict is
  blocking unless the same pull request carries a superseding record.
- A pull request that sets a record to Accepted or Rejected, or changes an Accepted record,
  merges only when the founder asked for that change.
- When behaviour a record describes changes, the record changes in the same pull request,
  and `bun run scripts/records.ts check` passes.
- Commits cite the records they serve in a `Refs:` trailer; tests cite the ID they prove.

## 2. Configurable by default (BR-098 to BR-105)

- A new duration, threshold, retention, limit or policy that someone could want different
  is a named setting with a default, not a constant (BR-100).
- A job that more than one common tool can do goes through a driver with one default
  (BR-099).
- A setting is stored once at its owner, means the same in every surface, and its changes
  are audited (BR-101).

## 3. Safety and the org wall

- Every read and write is scoped to the caller's org; another org's data stays out of
  reach (BR-009).
- A stored secret never goes back to a client (BR-010). A shell into a service that mounts
  secrets needs `secrets.read` as well as `terminal.open` (DR-043).
- Every state change writes one audit row through the single audit writer, and so does
  every denial (BR-007, DR-037).
- Destructive actions are policy-gated (DR-036); destructive GitOps steps wait for a
  person (DR-017).
- The protocol only grows: no message type or field is removed or renamed (BR-011).
- Nodes need zero inbound ports; the controller never dials a node (BR-004).
- Deploys pin an `@sha256` digest, never a floating tag (DR-015).

## 4. Where state lives (DR-005)

- Swarm state lives on Docker labels, configs and secrets. A new Prisma model or column for
  swarm state is a finding; the database holds identity, access, audit and history.
- A schema change ships a migration, and `bun run db:check` passes.

## 5. Tests (`testing-conventions`)

- New logic has a colocated `bun test` with inline fixtures.
- None of the five required gates loses an assertion, and a changed golden comes with the
  source change that explains it.
- A new protocol message has its parse round-trip test.

## 6. The pull request

- The title is a Conventional Commit with a scope from `commitlint.config.mjs`.
- Every commit is signed off (DCO).
- Every CI check on the head commit has passed.
- The description says what changed, why, and how it was tested.

## Severity

- **Blocking:** a bug, a broken Accepted record, a broken rule in section 3, a lost test
  gate, or a red check. Holds the merge.
- **Fix first:** a missing record update, test or setting, when fixing it is cheap. Holds
  the merge until fixed or explained in the review.
- **Note:** anything else. Doesn't hold the merge.
