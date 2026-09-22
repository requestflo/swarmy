# Org signing key generation always fails — cosign container can't write to its own key volume (UID mismatch)

**Status:** Fixed (2026-09) — `container.runOnce` gained a `user` field; the cosign keygen one-shot runs as `0:0`.
**Severity:** Major — this is the enabling step for "Only deploy signed images" (Image policy).
That gate can never be turned on in any real deployment, because the one action that provisions
the signing key it depends on always fails.

## Symptom

Deploy → CI & builds → Image policy → "Org signing key" → clicked "Generate key". Button shows
"Generating…" then reverts, with a red error toast:

```
cosign generate-key-pair exited 1: Error: open /keys/cosign.key: permission denied
main.go:74: error during command execution: open /keys/cosign.key: permission denied
```

Confirmed the toast wiring itself is correct — this is not a UX/silent-failure bug (an earlier,
premature read of this symptom in the readiness plan called it "silent failure"; that framing was
wrong and has been corrected — see plan row 29). `apps/app/src/components/ci/scan-policy-card.tsx:37-45`
has a proper `onError: (e) => toast.error(e.message)` handler; the toast just wasn't caught in an
earlier screenshot. Confirmed the exact error via a direct `fetch()` to
`/api/trpc/registryPolicy.enableSigning?batch=1`, which returns HTTP 400 with the message above and
a stack trace pointing at `packages/trpc/src/services/registryPolicy.service.ts:434`.

## Root cause

`enableSigning` (`packages/trpc/src/services/registryPolicy.service.ts:412-471`):

- Builds a per-org Docker volume name: `swarmy-cosign-keygen-<first 12 chars of orgId>`
  (line 419, using `KEYGEN_VOLUME = 'swarmy-cosign-keygen'` at line 32).
- Dispatches a `container.runOnce` command to the node agent (lines 422-433):
  - `image: 'gcr.io/projectsigstore/cosign:v2.4.1'` (line 30, `COSIGN_IMAGE`)
  - `cmd: ['generate-key-pair', '--output-key-prefix', '/keys/cosign']`
  - `binds: ['<volume>:/keys']`
  - No `user`/UID override anywhere in the payload.

On the agent side, `apps/agent/src/handlers/swarmres.ts:95-156` (`runOnce()`) builds the container
spec with `HostConfig: { Binds: p.binds, AutoRemove: false, NetworkMode: p.networks?.[0] }`
(swarmres.ts:109-120) — **no `User` field is ever set**. The wire schema itself,
`RunOncePayload` (`packages/core/src/protocol/swarmres.ts:107-120`), has no `user`/`uid` field at
all, so there is no way for `enableSigning` to request a specific UID even if it wanted to — the
container always runs as whatever `USER` is baked into the image.

The bind string `<volume>:/keys` is a plain name, not an absolute path, so Docker treats it as a
**named volume**. Neither `deploy/swarmy.lite.stack.yml` nor `deploy/swarmy.standard.stack.yml`
declares `swarmy-cosign-keygen*` under `volumes:`, and no code anywhere pre-creates or `chown`s
this volume. Docker therefore auto-creates it lazily on first use, owned **root:root**, mode
`0755` — no write access for non-root/non-group users.

`gcr.io/projectsigstore/cosign:v2.4.1` is the official upstream Sigstore image, built on a
`ko`-style distroless **nonroot** base that runs as an unprivileged UID (65532) by default, not
root.

**Result:** cosign, running as its non-root default UID, tries to write
`/keys/cosign.key` inside a directory owned by root with no write bit for other users →
`permission denied`. This is a straightforward UID/ownership mismatch between an auto-created
root-owned volume and a container that never runs as root and can't be told to.

A second `runOnce` in the same function (lines 437-451, using `busybox:1.36` to `cat` the PEMs
back and delete them) would hit the identical problem even if the first step somehow succeeded,
since `busybox:1.36` defaults to root and could read/delete root-owned files fine — so only the
first (`cosign`) step is actually broken, but any future fix needs to keep both steps' UID
expectations consistent.

## Why this matters

"Only deploy signed images" (the adjacent toggle on the same Image policy card) is a real,
UI-exposed, deploy-blocking security gate — but it can never be turned on, because its
prerequisite (an org signing key) can never be generated. Like the build-trigger and controller-
backup findings elsewhere in this sweep, this is not a rare edge case: it fails identically for
every org, every time, on every node, because the bug is in how the feature provisions its own
storage, not in any user-controlled configuration.

## Suggested fix direction

- Simplest: add a cheap `busybox`/`alpine` pre-step (mirroring the existing pattern already used
  for the readback step at lines 437-451) that `chown`s `/keys` to UID 65532 (cosign's default
  nonroot UID) before the `cosign generate-key-pair` step runs.
- Alternative: add a `user` field to `RunOncePayload` (`packages/core/src/protocol/swarmres.ts:107-120`)
  and thread it through `runOnce()` (`apps/agent/src/handlers/swarmres.ts:109-120`) so callers can
  pin a specific UID/GID on the bind mount — more general, useful for any future `runOnce` caller
  with the same class of problem.
- Either way, add an integration test that actually calls `enableSigning` end-to-end against a real
  cosign image and a freshly-created volume, not just unit-level coverage — this is the same
  "always fails, first invocation, every environment" shape as
  [[controller-backup-restic-not-found-in-path]] and
  [[ci-build-trigger-always-fails-no-enable-path]]: a whole feature that has evidently never been
  exercised end-to-end before shipping.

## Not yet tested

Whether manually pre-creating the `swarmy-cosign-keygen-<orgId>` volume with correct ownership
(out of product-surface bounds for this sweep) would let key generation succeed on a retry — not
attempted, per the standing "no manual node fixes" boundary. Whether the same
`container.runOnce` no-UID-override gap affects any other feature that dispatches `runOnce` against
a non-root image — not surveyed beyond this one call site.

## Fix applied (2026-09)

Reproduced live first: `docker run -v <fresh-vol>:/keys gcr.io/projectsigstore/cosign:v2.4.1
generate-key-pair …` → `open /keys/cosign.key: permission denied`; the same with `--user 0:0`
→ keys written, and the `busybox:1.36` readback/delete step reads them fine (both root).

- `packages/core/src/protocol/swarmres.ts:123` — `RunOncePayload.user` (optional; `uid`,
  `uid:gid` or name, regex-validated). Omitted ⇒ image default, so existing callers are unchanged.
- `apps/agent/src/handlers/swarmres.ts:113` — `runOnce` sets Docker `User` when provided.
- `packages/trpc/src/services/registryPolicy.service.ts:35,435` — `KEYGEN_USER = '0:0'` on the
  cosign `generate-key-pair` dispatch; readback step unchanged (busybox is root), so both steps
  agree on ownership.
- Tests: `packages/core/src/protocol/swarmres.test.ts` (new — payload validation + JSON
  round-trip through the `ControllerToAgentMessage` discriminated union carrying `user`);
  `packages/trpc/src/services/registryPolicy.service.test.ts:188` (`enableSigning` with a fake
  hub asserts the cosign one-shot carries `user: '0:0'` and both steps share the volume).

Caveat: an agent that has not yet self-updated strips the unknown `user` key (zod) and will still
fail until it updates.
