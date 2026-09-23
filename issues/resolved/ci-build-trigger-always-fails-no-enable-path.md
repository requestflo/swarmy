# CI "Build" trigger always fails with "build disabled on this agent" — and there is no dashboard, install-script, or profile path to enable it

**Status:** Fixed (2026-09) — "Builder" is now a node role toggleable in the dashboard, defaulted
on for single-node orgs; see "Fix applied (2026-09)" below.
**Severity:** Major — this is not a misconfiguration a user can fix. The entire "push to deploy,
build on your nodes" pitch of the CI & builds feature (the page's own tagline) cannot produce a
single successful build, on any node, in any deployment produced by the product's own install
flow, because the gate that would allow it is never turned on by anything the product ships.

## Symptom

Linked a repo via the real "Link a repo" form (`https://github.com/octocat/Hello-World.git`,
GitHub, branch `main`, a token) — this succeeded cleanly (see plan row 25). Clicked the resulting
row's "Build" button. Got an immediate red toast:

```
build disabled on this agent
```

No build ever appears in the "Builds" panel (`0 builds`, unchanged before and after).

## Root cause

The dashboard's "Build" button sends `cicd.triggerBuild`, which reaches the target node's agent
over its WebSocket command channel. The agent rejects it outright:

- `apps/agent/src/executor.ts:170` — the `buildImage` command case checks
  `if (!env.ALLOW_BUILD)` before ever calling `handlers/build.ts:buildImage()`.
- `apps/agent/src/executor.ts:174` — on failure, returns
  `error: { code: 'E_BUILD_DISABLED', message: 'build disabled on this agent' }` — the exact string
  surfaced verbatim as the dashboard toast.
- `apps/agent/src/env.ts:60` — `ALLOW_BUILD: (process.env.SWARMY_ALLOW_BUILD ?? 'false') === 'true'`.
  **Defaults to `false`.** Same default-off pattern as `SWARMY_ALLOW_EXEC` /
  `SWARMY_ALLOW_NODE_SHELL`, unlike `SWARMY_ALLOW_MESH` which defaults on.
- `scripts/run-agent.sh:42` sets `SWARMY_ALLOW_BUILD="${SWARMY_ALLOW_BUILD:-false}"` — a local/dev
  script only, not part of any deployed install path.

**No user-facing way to turn this on exists anywhere in the product:**

- Dashboard: `apps/app/src/components/nodes/node-role-switches.tsx` only exposes the four
  `swarmy.node.*` label toggles (ingress/outlet/storage/database) via `trpc.nodes.setRole`. There
  is no build/exec-permission switch anywhere in `apps/app`, and no reference to
  `SWARMY_ALLOW_BUILD` in `apps/app` or `apps/api` at all.
- Install flow: neither `apps/api/src/install-script.ts` nor `apps/api/src/install/installer.ts`
  (which generate the exact one-line install commands the dashboard hands a user for node
  enrollment) thread `SWARMY_ALLOW_BUILD` through as an env var — only `SWARMY_ALLOW_MESH` is
  wired into the generated command.
- Docs: `docs/LOCAL-SWARM.md` only documents `SWARMY_ALLOW_MESH`; `SWARMY_ALLOW_BUILD` is
  undocumented anywhere a user would find it.

The only way to enable this today is for an operator to manually set
`SWARMY_ALLOW_BUILD=true` in the agent's env file or container `-e` flag on every node they want
builds to run on — a manual, undocumented, out-of-band step directly contradicting the "no
babysitting, no dialing into a machine" bar this sweep is testing against.

## Why this matters

This looks like an intentional, unimplemented safety default rather than a bug in the strict
sense (`apps/agent/src/handlers/build.ts:1-2` carries a comment referencing an
"epic: git-cicd-registry, MVP" tag, suggesting the gate was deliberately left off pending further
build-sandboxing work). But from a product-readiness standpoint the effect is the same as a bug:
the "CI & builds" page is fully wired up and presented as a working feature — repo linking works,
the registry exists, GC/image-policy settings save — right up until the one action that actually
does something (`triggerBuild`) always fails, silently unless you specifically inspect the toast
text, with zero indication anywhere in the UI that this requires a manual per-node env var an
operator would have to already know about.

## Suggested fix direction

- Short term: surface this precondition in the UI itself — e.g. disable/grey out the "Build"
  button with a tooltip ("builds are disabled on all nodes — enable `SWARMY_ALLOW_BUILD` on at
  least one node") instead of letting a user click it and get a bare toast.
- Medium term: expose this as a real node-role toggle alongside the existing
  ingress/outlet/storage/database switches in `node-role-switches.tsx`, wired through
  `trpc.nodes.setRole` the same way, so enabling builds is a dashboard action, not an SSH one.
- Wire the equivalent env var into the generated install one-liner (`install-script.ts` /
  `installer.ts`) as an optional flag, the same way `SWARMY_ALLOW_MESH` is threaded through today.

## Not yet tested

Whether manually setting `SWARMY_ALLOW_BUILD=true` on the agent (out of product-surface bounds for
this sweep) actually produces a working build end-to-end — untested, since doing so would violate
the standing "no manual node fixes" boundary. The `SWARMY_ALLOW_EXEC` / `SWARMY_ALLOW_NODE_SHELL`
gates follow the identical default-off, no-enable-path pattern and likely have the same gap,
though not directly tested this segment.

## Fix applied (2026-09)

**Builds are a node capability controlled from the product. Docker node labels are the source of
truth, the same approach as the ingress/outlet/storage/database roles.**

- **Role label**: `swarmy.node.builder=true` (`NODE_BUILDER_LABEL`,
  `packages/core/src/types.ts:89`). The legacy `swarmy.role=builder` still counts. Pure helpers:
  - `parseBuildOverride`
  - `isBuilderCapable` (:118)
  - `buildGateAllows` (:134)
  - `BUILDER_ENABLE_HINT` (:141)
- **Node UI**: a "Builder" switch in the node role switches
  (`apps/app/src/components/nodes/node-role-switches.tsx:82`). It goes through
  `nodes.setRole({ builder })` (`packages/trpc/src/routers/nodes.ts:58`) →
  `setNodeRole` (`packages/trpc/src/services/node.service.ts:237`). Turning it off also clears the
  legacy label. `NodeSummary` exposes `builder` and `buildOverride`, and the switch hint says when
  the box's env overrides it.
- **How the agent learns it**: the controller reads the label live when it dispatches, and asserts
  it in the payload as `builderCapable` (`packages/core/src/protocol/build.ts:61`, `prune.ts:53`).
  Agent gate: `buildGateAllows(env.BUILD_OVERRIDE, p.builderCapable)`
  (`apps/agent/src/executor.ts:179,191`). The assertion is always current and needs no
  session-push plumbing. An older controller doesn't send the field, so those agents stay off by
  default.
- **`SWARMY_ALLOW_BUILD` stays an explicit override** (`apps/agent/src/env.ts:66`):
  - `true` forces builds on and `false` vetoes them even when the role is on. Unset means the role
    decides.
  - The agent reports the override in its register facts (`buildOverride`,
    `packages/core/src/protocol/auth.ts:45`; `apps/agent/src/daemon.ts:242`). The gateway stores it
    (`apps/api/src/gateway/protocol-handlers.ts:291`), so the controller's picker honours it.
  - The installer threads an explicit `SWARMY_ALLOW_BUILD` into agent.env / the container and
    keeps it on repair (`apps/api/src/install/installer.ts:81,187,230,283`).
  - `scripts/run-agent.sh` no longer defaults it to `false`, which would now act as a veto.
- **Dispatch** (`packages/trpc/src/services/cicd.service.ts:683` pure `pickBuilderNode`, :700
  `resolveBuilderNode`): only picks an online builder-capable node and never falls back to a
  non-builder. With no builder it fails before any `Build` row is created, with
  `PRECONDITION_FAILED` "No node can run builds yet — turn on the 'Builder' role for a node
  (Nodes → pick a node → Controls → Builder), or set SWARMY_ALLOW_BUILD=true in that node's
  /etc/swarmy/agent.env". If the builders are offline it names them. The agent's own
  `E_BUILD_DISABLED` message now says why it refused (role off or local veto) and how to fix it
  (`apps/agent/src/executor.ts:39`).
- **Image GC** (`packages/trpc/src/services/image-gc.service.ts:105`) prunes only on
  builder-capable nodes, with `builderCapable: true`. The registry scan-node picker uses the same
  label helper.
- **Single-node default**: when a brand-new node enrolls and it is the org's only node, it gets the
  Builder role once the swarm join lands. See `stampDefaultBuilderRole`
  (`packages/trpc/src/services/node.service.ts:344`), wired in
  `apps/api/src/gateway/protocol-handlers.ts:347`. It only runs for new nodes, never on
  re-adoption or repair, so an operator's "off" sticks.

**Tests**:
- `packages/trpc/src/services/cicd.builder.test.ts` covers picking, overrides, no fallback, the
  actionable reasons, and the single-node default.
- `packages/core/src/types.test.ts` covers the override parse and gate.

**Docs**: `docs/product/cicd-and-registry.md` and the `cicd-registry` skill are updated.
