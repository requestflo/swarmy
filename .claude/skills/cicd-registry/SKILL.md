---
name: cicd-registry
description: Invariants, contracts, and file map for swarmy's git CI/CD + in-swarm registry — BuildKit builds as an agent command, the single `registry:2` swarm service, Trivy CVE scans + cosign signing/admission, image GC that never prunes an in-prod digest, and PR preview environments. Load before touching anything under services/{cicd,image-gc,registryPolicy,admission-images,previews}.service.ts, routers/{cicd,registryPolicy,previews}.ts, apps/agent/src/handlers/{build,prune,registry-tls}.ts, protocol/build.ts, apps/api/src/webhooks.ts, the image-gc/preview-reconcile workers, or the /ci UI. Product rationale lives in docs/product/cicd-and-registry.md.
---

# CI/CD & registry: build → push → scan → deploy → GC

Read `docs/product/cicd-and-registry.md` for WHY a `git push` ships with no
external CI. This skill is the HOW: the invariants every change must keep, and
where everything lives. A build/prune is an agent command — the protocol third
of a feature slice is `skill("agent-handlers")`; the full-slice shape is
`skill("add-feature-slice")`.

## Invariants (violating any of these is a bug, not a style choice)

1. **A build is an agent command, not a controller job.** `image.build` /
   `image.prune` are one entry each in `packages/core/src/protocol/build.ts`
   (added to the `ControllerToAgentMessage` union), in `COMMAND_PROTOCOL_TYPE`
   (`packages/trpc/src/hub/types.ts`: `'image.build'→'buildImage'`,
   `'image.prune'→'pruneImages'`), and a `case` in `apps/agent/src/executor.ts`.
   The build runs on the agent against its LOCAL Docker socket; the controller
   never builds and never touches a node socket (`skill("agent-handlers")`).
2. **Builds are gated + off by default.** The executor rejects `buildImage` /
   `pruneImages` with `E_BUILD_DISABLED` unless `env.ALLOW_BUILD`
   (`SWARMY_ALLOW_BUILD=true`, `apps/agent/src/env.ts`). Rootless BuildKit
   (`moby/buildkit:rootless`), never the node's main daemon — build = arbitrary
   repo code.
3. **Deploy by DIGEST, never a floating tag.** Every build resolves to
   `host/name@sha256:…` (parsed from BuildKit's `containerimage.digest`);
   autodeploy and the "in prod" pinning both depend on this. A `:latest` deploy
   breaks rollback and GC — reject it.
4. **GC never prunes an in-prod digest.** The pinned set is computed LIVE from
   the hub inventory (`computePinnedDigests`: every running service's resolved
   `@sha256` image + every running container's digest), NOT from any DB row. The
   pure `computeGcPlan` guarantees `pinnedDigests ∩ remove = ∅` regardless of
   mode/age; the agent's `selectImagesToPrune` ALSO refuses to delete a pinned
   digest and scopes to `repoPrefix` (swarmy-pushed images only) — defence in
   depth. `keepProd:false` is the explicit hobby opt-out.
5. **The registry is a swarm service swarmy manages, never public.** Enabling it
   is one `service.deploy` of `registry:2` (`REGISTRY_IMAGE`), replicas 1, on the
   `swarmy` overlay, volume `swarmy-registry-data`, reachable at
   `swarmy-registry:5000` (`DEFAULT_REGISTRY_HOST`). Do not add a public port;
   the agent only RENDERS TLS/insecure-registry hints — it never rewrites
   `/etc/docker/daemon.json` itself (`handlers/registry-tls.ts`).
6. **Secrets are JIT-resolved and never baked in.** Git tokens, registry creds,
   and the cosign private key are stored encrypted (`@swarmy/core/crypto` vault,
   `SWARMY_SECRET_KEY`), decrypted at dispatch, passed as a git auth header /
   one-shot Docker config / `env://` — never written into an image layer, never
   returned to a client. `cosignPrivateKeyEnc` NEVER crosses a router boundary;
   only `cosignPublicKey` + an `enabled` flag do.
7. **The controller is the only public surface.** `POST /webhooks/git/:repoId`
   verifies the provider HMAC (`verifyWebhookSignature`: GitHub
   `X-Hub-Signature-256`, GitLab constant-time `X-Gitlab-Token`) before doing any
   work, filters to the watched branch, and triggers a SYSTEM build. Never build
   on an unverified payload.
8. **Scan/sign is fire-and-forget; admission is fail-closed.** `onImageBuilt`
   (Trivy scan + cosign sign) runs `void … .catch()` after a build — it must
   never delay or fail the build. `admission-images.evaluate` gates DEPLOYS only:
   critical CVEs `block`, unscanned `warn`, unsigned `block`, signature
   unverifiable → **fail closed** (treated as a block). Only org-registry images
   (`isOrgRegistryImage`) are in scope.
9. **A preview is Docker-truth; one DB write only.** A PR deploys
   `pr<N>-<repo-short>` from the linked stack's compose with the built image
   swapped in, all published ports dropped (the `pr-<N>.<baseDomain>` ingress
   route label is the only front door), on the shared `swarmy` overlay. Identity
   lives entirely in `swarmy.preview.*` service labels; the list/expiry/teardown
   are derived from live labels. The ONLY DB write is `GitRepo.previewsJson`
   (repo input config). See `skill("docker-native-storage")`.
10. **Docker owns "what runs"; the DB owns swarmy's identity + history.** New CI
    state that describes a running thing (registry, builder role, preview stack)
    is a Docker label/service, not a Prisma column. `Build`/`ImageScan` are
    queryable HISTORY (which build made which digest, what CVEs); `RegistryConfig`
    /`ImageGcPolicy` are config + the encrypted cosign key. If you reach for a
    column that mirrors swarm state, stop.

## Contracts between the layers

- **Controller → agent build**: `ctx.hub.dispatch(nodeId, 'image.build',
  { commandId, source:{url,ref,token?}, imageRefs, pushPolicy:'always',
  registryAuth? }, { timeoutMs: 1_800_000 })`. Result `{ digest, imageRefs }`.
  The builder node is `resolveBuilderNode(ctx)`: a `swarmy.role=builder`-labeled
  online node (label read live via `ctx.hub.nodeInfoFor`), else any online node,
  else the manager.
- **Build logs**: the agent streams `conn.send('logChunk', { commandId, … })`
  keyed by `commandId == Build.logsRef`; the gateway bridge feeds
  `build-log-bus.ts`, which `subscribeBuildLog`/`getBuildLogPage` replay + tail.
  Reuses the exact `streamLogs` plumbing — do not invent a second log path.
- **Build → deploy bridge**: on `SUCCEEDED`, `image` becomes `host/name@digest`;
  `autodeployBuilt` redeploys the linked service via `service.deploy` pinned to
  that digest. `Build.image` (digest form) is what GC candidates read.
- **GC**: `image-gc` worker (`runImageGcAllOrgs`) + `cicd.runGc` (dryRun) →
  `computePinnedDigests` → `computeGcPlan` → dispatch `image.prune`
  ({ keepDigests: plan.pinned, repoPrefix, strategy, untilDays?, dryRun }) to
  every online node. Modes: `ON_HEALTHCHECK` (prune all non-pinned) / `AGE_DAYS`.
- **Admission (spine)**: `admission-images.evaluate(ctx, intent)` is called by
  the admission spine on `stack.deploy`/`service.deploy`; returns `Violation[]`
  (`images/critical-cves` block, `images/unscanned` warn, `images/unsigned`
  block). `verifyImageSignature` runs cosign in a `container.runOnce` on a
  builder node; verify is memoized per digest for `VERIFY_CACHE_TTL_MS` (10 min).
- **Previews**: the webhook receiver loads `previews.service` (dynamic seam — see
  the ORCHESTRATOR TODO in `apps/api/src/webhooks.ts`) and calls
  `parsePrWebhookEvent` + `handlePrEventForRepo`; TTL sweep is the
  `preview-reconcile` worker calling `teardownExpiredPreviews`.

## File map

| Concern | Where |
|---|---|
| Repos / build core / registry enable / GC policy / live logs | `packages/trpc/src/services/cicd.service.ts` |
| GC pinned-set + plan execution (dispatch prune) | `packages/trpc/src/services/image-gc.service.ts` |
| Trivy scan, cosign keygen/sign/verify, policy | `packages/trpc/src/services/registryPolicy.service.ts` |
| Image admission decision (pure + evaluator) | `packages/trpc/src/services/admission-images.ts` |
| PR preview lifecycle (labels, specs, teardown, webhook parse) | `packages/trpc/src/services/previews.service.ts` |
| Build-log fan-out bus | `packages/trpc/src/services/build-log-bus.ts` |
| tRPC surface | `packages/trpc/src/routers/{cicd,registryPolicy,previews}.ts` |
| Agent: BuildKit build / image prune / TLS hint | `apps/agent/src/handlers/{build,prune,registry-tls}.ts` |
| Build gate (`env.ALLOW_BUILD`) + executor cases | `apps/agent/src/{env,executor}.ts` |
| Wire protocol (build/prune payloads + results) | `packages/core/src/protocol/build.ts` (+ `messages.ts`) |
| `CommandName` → wire `type` | `packages/trpc/src/hub/types.ts` (`COMMAND_PROTOCOL_TYPE`) |
| Git webhook receiver (HMAC verify → SYSTEM build / PR) | `apps/api/src/webhooks.ts` + `apps/api/src/webhook-verify.ts` |
| Background sweeps (GC / preview TTL) | `apps/api/src/workers/{image-gc,preview-reconcile}.ts` |
| Prisma models | `packages/db/prisma/schema/cicd.prisma` (`GitRepo`/`Build`/`RegistryConfig`/`ImageGcPolicy`/`ImageScan`) |
| `/ci` workspace UI | `apps/app/src/routes/_authed/ci.tsx` |

## Adding a build/registry capability (the recipe)

1. **Protocol**: add the payload + result to `packages/core/src/protocol/build.ts`
   with a `commandId`; wire it into the `ControllerToAgentMessage` union in
   `messages.ts`.
2. **Registry**: add the `CommandName` and its wire `type` to
   `COMMAND_PROTOCOL_TYPE` (`packages/trpc/src/hub/types.ts`).
3. **Executor**: add a `case` in `apps/agent/src/executor.ts` — gate anything
   build/prune-shaped behind `env.ALLOW_BUILD` (reject `E_BUILD_DISABLED`), wrap
   work in `run(conn, commandId, …)`, call a thin handler in
   `apps/agent/src/handlers/` over `@swarmy/core/docker`.
4. **Service + router**: dispatch from a `cicd.service`/`registryPolicy.service`
   function via `ctx.hub.dispatch`, org-scope + `writeAudit`, and expose it on
   the matching router (admin-only for mutations). Keep decision logic PURE and
   unit-tested (`computeGcPlan`, `decideImageAdmission`, `buildPreviewSpecs`,
   `selectImagesToPrune`).
5. **Never** deploy by tag, publish the registry, return an encrypted secret, or
   store "what's in prod" in the DB.

## Operational gotchas

- The registry is a chicken-and-egg on first run: `registry:2`, BuildKit, Trivy,
  and cosign images must be pullable from a public registry to bootstrap.
- BuildKit's cache volume is itself a disk consumer — GC prunes images, not the
  build cache; watch it on builder nodes.
- Single-replica registry is a data-loss SPOT — treat it as cache-rebuildable
  (rebuild from git); document S3 storage for HA.
- The webhook secret is decrypted and surfaced exactly once (`getWebhookInfo`)
  so the operator can paste it into the provider — never log it elsewhere.
- Verify: `bun --filter @swarmy/trpc typecheck` and the pure-core tests
  (`image-gc.test.ts`, `admission-images.test.ts`, `previews.service.test.ts`,
  `prune.test.ts`, `registryPolicy.service.test.ts`) plus the protocol
  round-trip over `build.ts`. Multi-node: `scripts/local-vms.sh`
  (`skill("run-local")`) — label a node `swarmy.role=builder`, set
  `SWARMY_ALLOW_BUILD=true`, wire a repo, push, watch the build stream and the
  service redeploy to the new digest.
