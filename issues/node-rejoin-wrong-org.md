# Node re-enrollment ignores a fresh join token for a different org — FIXED

**Status:** Fixed 2026-07-10.

## Symptom

Re-running the install one-liner on an already-enrolled box, with a brand-new
`SWARMY_JOIN_TOKEN` minted for a **different** org, silently re-registered the
node under its **old** org. The dashboard for the new org showed "0 of 0 nodes
online" even though the agent logged a successful `registered as node
<id>` line. The join token minted for the new org showed `uses: 0` in the DB —
it was never actually consumed.

## Root cause

`apps/agent/src/daemon.ts` (`buildRegister()`) unconditionally prefers a
locally persisted session over the join token:

```ts
const buildRegister = (): RegisterPayload => ({
  auth: state
    ? { kind: 'session', nodeId: state.nodeId, sessionSecret: state.sessionSecret }
    : { kind: 'join', joinToken: env.JOIN_TOKEN },
  facts,
});
```

`state` is loaded from `SWARMY_AGENT_STATE` (`/var/lib/swarmy/agent.json` for
the systemd backend, or the `swarmy-agent` Docker volume for the container
backend). The installer's REPAIR-mode path (`apps/api/src/install/installer.ts`)
intentionally preserves this file across reinstalls so a bare re-run of the
one-liner never loses a node's identity — but it never checked whether the
*newly supplied* join token actually still pointed at the same org/install as
the one that produced the saved session. Any local state file at all — even
one from a completely different org or controller — silently wins over an
explicit, freshly-minted `SWARMY_JOIN_TOKEN`.

## Fix

`apps/api/src/install/installer.ts`: capture the join token as it was
explicitly passed to the one-liner (`EXPLICIT_JOIN_TOKEN`), before the
REPAIR-mode salvage step can backfill it from the existing env file. If that
explicit token differs from what's already on disk, treat it as an
intentional re-enroll and drop the stale local session before the agent
starts — `$STATE_DIR/agent.json` for the systemd backend, `docker volume rm
$STATE_VOLUME` for the container backend. A bare re-run of the one-liner
(no new token passed) is unaffected and still preserves identity as before.

Verified end-to-end: re-installed on `lima-swarmy-node-1` and
`lima-swarmy-node-2` (both had stale state from a prior org) with fresh
tokens for a new org — both produced brand-new `Node` rows under the new
org's `orgId`, and the join tokens were consumed (`uses: 1`).
