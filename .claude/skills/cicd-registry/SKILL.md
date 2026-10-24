---
name: cicd-registry
description: Invariants, contracts, and file map for swarmy's git CI/CD + in-swarm registry — BuildKit builds as an agent command, the single `registry:2` swarm service, Trivy CVE scans + cosign signing/admission, image GC that never prunes an in-prod digest, and PR preview environments. Load before touching anything under services/{cicd,image-gc,registryPolicy,admission-images}.service.ts, routers/{cicd,registryPolicy}.ts, apps/agent/src/handlers/{build,prune}.ts, protocol/build.ts, apps/api/src/webhooks.ts, the image-gc worker, or the /ci UI. Product rationale lives in docs/product/cicd-and-registry.md.
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
2. **Builds are gated to Builder-role nodes.** The executor rejects `buildImage` /
   `pruneImages` with `E_BUILD_DISABLED` unless `buildGateAllows(env.BUILD_OVERRIDE,
   payload.builderCapable)` (`@swarmy/core` types.ts): the controller asserts
   `builderCapable` for nodes with the `swarmy.node.builder` label (role switch;
   legacy `swarmy.role=builder` honoured); `SWARMY_ALLOW_BUILD` is an explicit
   local override (`true` forces on, `false` vetoes) reported in register facts
   (`buildOverride`). A single-node org's first node defaults to Builder. Rootless BuildKit
   (`moby/buildkit:rootless`), never the node's main daemon — build = arbitrary
   repo code.
3. **Deploy by DIGEST, never a floating tag.** Every build resolves to
   `host/name@sha256:…` (parsed from BuildKit's `containerimage.digest`);
   git-app deploys and the "in prod" pinning both depend on this. A `:latest` deploy
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
   encrypted, attachable `swarmy` overlay, volume `swarmy-registry-data`.
   Every node's dockerd pulls `localhost:5000` (`DEFAULT_REGISTRY_HOST`;
   127.0.0.0/8 is insecure-trusted by default) through the agent-supervised
   loopback forwarder (security review M16: `@swarmy/core/registry-forwarder`,
   `handlers/registry-forwarder.ts`; a plain Caddy container on `swarmy`
   publishing 127.0.0.1:5000/:5001 only, restart `always`, re-asserted every
   15s, independent of the controller). The registry's TOPOLOGY
   (`registry-topology.ts`) decides how a (re)deploy publishes: `loopback` (no
   port) once every ready node's agent reports `registryForwarder: on`, else
   `mesh` (:5000/:5001 on the routing mesh, the old shape), and it never goes
   back. EVERY registry/cache spec passes `registryTopologyFor(hub, orgId)`;
   the `system-image-mirror` worker's topology tick migrates old clusters with
   the GC window's pinned spec. `swarmy-registry:5000` is the
   LEGACY overlay-only host — `canonicalRegistryHost` maps it, and
   `isOrgRegistryImage` still recognises it. The builder runs host-network and
   pushes with `registry.insecure=true`; trivy/cosign `runOnce` use `host` too.
   EVERY agent also keeps a firewall floor (defence in depth since M16;
   `handlers/registry-firewall.ts`: a `SWARMY-REGISTRY` chain
   jumped from `DOCKER-USER`, re-asserted every 5 min) dropping forwarded
   traffic to :5000/:5001 except local docker bridges and
   `SWARMY_REGISTRY_FIREWALL_ALLOW`; `SWARMY_REGISTRY_FIREWALL=false` opts out.
   Never publish a new registry-ish port on the mesh or a non-loopback address;
   the agent never rewrites `/etc/docker/daemon.json` itself.
   The installers (never the agent) merge `registry-mirrors` → the Docker Hub
   pull-through cache (`swarmy-registry-cache`, :5001) into daemon.json.
   System images are MIRRORED into the registry (`swarmy-system/…`, BOM in
   `@swarmy/core/system-images`, `system-image-mirror` worker; the index lives
   in `swarmy.mirror.*` labels on the registry service, trusted only while the
   registry task stays on `swarmy.mirror.node`) and the hub decorator rewrites
   exact upstream system refs to the mirrored `@sha256` ref. A registry
   redeploy must carry `mirrorLabelsOf(live.labels)`.
6. **Secrets are JIT-resolved and never baked in.** Git tokens, registry creds,
   and the cosign private key are stored encrypted (`@swarmy/core/crypto` vault,
   `SWARMY_SECRET_KEY`), decrypted at dispatch, passed as a git auth header /
   one-shot Docker config / `env://` — never written into an image layer, never
   returned to a client. `cosignPrivateKeyEnc` NEVER crosses a router boundary;
   only `cosignPublicKey` + an `enabled` flag do.
7. **The controller is the only public surface.** `POST /webhooks/git/:repoId`
   verifies the provider HMAC (`verifyWebhookSignature`: GitHub
   `X-Hub-Signature-256`, GitLab constant-time `X-Gitlab-Token`, Gitea/Forgejo
   `X-Gitea-Signature` via `verifyGiteaSignature`) before doing any
   work, filters to the watched branch, and triggers a SYSTEM build. Never build
   on an unverified payload. Dedupe is durable: each verified delivery is
   recorded in control.db (`GitWebhookDelivery`, `apps/api/src/webhook-dedupe.ts`)
   under its delivery id AND the sha256 of the raw body (the id is an unsigned
   header), per endpoint, for 7 days. Past that the plan refuses a push of a
   commit that already ran in the environment and was replaced
   (`staleCommitReason`, `services/apps/stale-commit.ts`; status `stale`,
   audited `app.plan.stale`) unless the push's `before` is the live sha. Never
   go back to in-memory dedupe, and never let a push re-apply an old commit.
8. **Scan/sign is fire-and-forget; admission is fail-closed.** `onImageBuilt`
   (Trivy scan + cosign sign) runs `void … .catch()` after a build — it must
   never delay or fail the build. `admission-images.evaluate` gates DEPLOYS only:
   critical CVEs `block`, unscanned `warn`, unsigned `block`, signature
   unverifiable → **fail closed** (treated as a block). Only org-registry images
   (`isOrgRegistryImage`) are in scope.
9. **Previews are swarmy.yaml previews — there is one engine.** A PR, an
   opted-in branch (`previews.branches`) or a trial deploy (`createAppPreview`:
   CLI `deploy --preview`, MCP `trial_deploy`, REST `POST /apps/{repoId}/previews`)
   runs `planCommit` with `toDesired(cfg, { preview })` — its own stack, isolated
   resources, `AppPlan` rows (`environment: 'preview'`). `app-reconcile` tears
   them down past `previews.ttl`; a closed PR or deleted branch tears down at
   once. The dashboard's Branch previews page uses the same engine over tRPC:
   `apps.createPreview` (`orgProcedure`, the same guard as the REST route; the
   plan's own gates still apply) and `apps.teardownPreview`
   (`abacProcedure('stack.remove')` on the preview's live stack, audited
   `app.preview.teardown` with a `user` actor). The rules it shows come from
   production's last applied plan (`AppView.previewRules`, `previewRulesOf`)
   and are read-only: changing them is a commit. The older compose-swap engine
   (`previews.service`) was removed (2026-09).
10. **Docker owns "what runs"; the DB owns swarmy's identity + history.** New CI
    state that describes a running thing (registry, builder role, preview stack)
    is a Docker label/service, not a Prisma column. `Build`/`ImageScan` are
    queryable HISTORY (which build made which digest, what CVEs); `RegistryConfig`
    /`ImageGcPolicy` are config + the encrypted cosign key. If you reach for a
    column that mirrors swarm state, stop.

## Zero-config builds + registry cache invariants

- **Railpack rides the same `image.build`.** `builder` (`auto`|`dockerfile`|
  `railpack`), `railpack` and `cache` are additive payload fields; ABSENT
  `builder` must render the legacy Dockerfile program byte-for-byte (golden).
  `railpack prepare` runs INSIDE BuildKit on `bash:5.2` (mise needs bash; the
  BuildKit image is busybox) with the CLI copied from the pinned frontend
  image — plan and frontend are one version. Plan base images are rewritten
  tag → digest (or mirror). Bump `railpackFrontend/Builder/Runtime` together.
- **Build env values never hit argv, the plan, a layer or the log**: container
  env `SWARMY_BENV_<i>` → BuildKit `--secret` + `secrets-hash`.
- **Cache refs are `<image>:buildcache-*` tags only.** GC (`build-cache.ts`
  `planCacheGc` + `runCacheGcForOrg`) deletes TAGS matching that prefix, never a
  digest, and never one written inside the 24h grace window.
- Build containers are removed with `v: true` (the BuildKit image declares a
  state VOLUME; a plain remove leaks GBs per build).

## git-apps invariants (swarmy.yaml → GitOps)

11. **Credentials never enter a compose source.** The applier renders only
    addressing bindings into env; every credential binding becomes an attach
    call (`injectConnection`, cache/search/vector/bucket/secret attach) so the
    Stack row and Release snapshot stay secret-free and attachment-carry keeps
    the wiring across deploys. A named environment reads `<x>.<env>` instead
    of the shared `<x>` whenever that family exists (`own-secrets.ts`), so a
    cloned environment's secrets survive its adoption into swarmy.yaml.
12. **Destructive plan steps never auto-apply.** `planApp` gates them
    `confirm`; confirming re-plans the same commit and is ABAC-checked per step
    by what it destroys (`data.destroy` / `service.remove`), audited.
13. **The ledger is history, Docker is truth.** `AppPlan.ledgerJson` records
    what swarmy applied; `readLiveApp` intersects it with the live inventory
    and only touches services stamped `swarmy.app.stack=<stack>`.
14. **GitHub installation tokens are minted per use** (memory cache ≤ 55 min),
    never stored; an installation binds to an org only after the installing
    user's own OAuth token proves they can see it. Fork PRs never build. Each
    token is narrowed to the job: `repositories: [name]` plus only its
    permissions (`git-providers/github-token-scope.ts`: contents:read for
    clone/inspect/build/branches, checks/statuses/pull_requests:write for
    feedback, metadata only for the repo picker); a repo-scoped request without
    a repo name throws instead of widening, and the cache key is installation ×
    repo × permissions. A connection's credential attaches only to a remote on
    the connection's own host (`git-providers/clone-host.ts`: same hostname,
    same port per scheme, never https→http); `linkRepo`/`inspectSource` refuse
    a mismatch before minting anything, and `repoCredentials` refuses old rows.
15. **Every provider round-trip is bound to the browser that started it.**
    Starting a GitHub App / GitLab / Gitea flow sets a 10-minute host-only
    `__Host-swarmy-git-bind` cookie and signs only its sha256 into `state`
    (`services/git-browser-bind.ts`, `git-providers/state.ts`); every callback
    must present the matching cookie, and a flow can't start without an HTTP
    response to carry it. Registering the controller-wide GitHub App is
    `instanceOwnerProcedure` (`startGithubManifest`, re-checked in the manifest
    callback); installing it stays open to every org's admins.
16. **A dashboard environment is a clone, not a preview.**
    `apps.cloneEnvironment` (`services/apps/clone.ts`, `abacProcedure
    ('stack.deploy')` on the source, audited `app.environment.clone`) runs
    `planCommit` with a `clone` (pure desired state: `@swarmy/app-config`
    `clone-env.ts`): its own stack `<app>-<name>`, no TTL, never swept, marked
    in the `AppPlan` desired until swarmy.yaml names it. Secrets are never
    copied: each is an empty slot filled write-only by
    `apps.setEnvironmentSecret` into the environment's own family
    `<family>.<env>` (`services/apps/env-secrets.ts`), mounted at the path the
    app already reads. `apps.envLayers` (pure `env-layers.ts`: service env ›
    `environments.<name>.env` › shared) masks secret-looking values itself.

## Contracts between the layers

- **Pull auth (hub decorator)**: every `service.deploy`/`image.pull` passes
  `createRegistryAuthDecorator`: explicit `registryAuth` wins → org in-swarm
  registry login (org-registry images) → org `RegistryCredential` whose
  `host[/path]` prefix is the LONGEST match (`matchCredential`; Docker Hub
  shorthands resolve to `docker.io/library/...`). `image.build` gets every login
  as `pullAuths` (private `FROM` bases), merged into the one-shot docker config
  by `renderDockerConfig`. Creds are cached per org for 15s and invalidated on
  write. Never attach them at a call site. Use `resolveRegistryAuthFor` only when
  the call doesn't go through the hub. Ref splitting and the longest-prefix
  match (`splitImageRef`, `matchCredential`) are pure in `@swarmy/core`
  `image-ref.ts`, shared by the decorator and the dashboard's "which login will
  this image use?" (`components/ci/registry-credentials-resolve.ts`), so both
  answer the same way. Change the rule there, never in one caller.

- **Controller → agent build**: `ctx.hub.dispatch(nodeId, 'image.build',
  { commandId, source:{url,ref,token?}, imageRefs, pushPolicy:'always',
  registryAuth? }, { timeoutMs: 1_800_000 })`. Result `{ digest, imageRefs }`.
  The builder node is `resolveBuilderNode(ctx)` → pure `pickBuilderNode`: an
  online builder-capable node (label read live via `ctx.hub.nodeInfoFor`, override
  via `ctx.hub.agentBuildFor`). No fallback to non-builders — it throws
  PRECONDITION_FAILED with `BUILDER_ENABLE_HINT`. Payload carries `builderCapable: true`.
- **Build logs**: the agent streams `conn.send('logChunk', { commandId, … })`
  keyed by `commandId == Build.logsRef`; the gateway bridge feeds
  `build-log-bus.ts`, which `subscribeBuildLog`/`getBuildLogPage` replay + tail.
  Reuses the exact `streamLogs` plumbing — do not invent a second log path.
- **Build → deploy bridge**: on `SUCCEEDED`, `image` becomes `host/name@digest`;
  the git-app plan (`apps.service`) deploys that digest. `Build.image` (digest
  form) is what GC candidates read. (The old "link a repo to one service +
  autodeploy" path was removed in 2026-09 — every repo is a git app.)
- **GC**: `image-gc` worker (`runImageGcAllOrgs`) + `cicd.runGc` (dryRun) →
  `computePinnedDigests` → `computeGcPlan` → dispatch `image.prune`
  ({ keepDigests: plan.pinned (+ plan.kept), repoPrefix, strategy, untilDays?, dryRun })
  to every online node. Modes: `ON_HEALTHCHECK` (prune all non-pinned) /
  `AGE_DAYS` / `KEEP_LAST` (newest N per registry repo + anything pinned).
  Then the registry-side pass (`registry-gc.service.ts`, worker-held signature
  gate): read-only scan one-shot on the volume's node → `planRegistryGc` (pure;
  the LIVE pinned set always wins, even with `keepProd:false`; ON_HEALTHCHECK
  keeps builds in the registry; untagged leftovers swept in every mode; 24h
  grace) → `DELETE /v2/<repo>/manifests/<digest>` (regctl) → read-only window
  (`REGISTRY_STORAGE_MAINTENANCE_READONLY`, pinned to the volume node,
  stop-first) → `registry garbage-collect` → read-write. Never
  `--delete-untagged` (registry 2.x drops multi-arch children + untagged
  in-prod digests).
- **Admission (spine)**: `admission-images.evaluate(ctx, intent)` is called by
  the admission spine on `stack.deploy`/`service.deploy`; returns `Violation[]`
  (`images/critical-cves` block, `images/unscanned` warn, `images/unsigned`
  block). `verifyImageSignature` runs cosign in a `container.runOnce` on a
  builder node; verify is memoized per digest for `VERIFY_CACHE_TTL_MS` (10 min).
- **Previews**: the webhook receiver parses PR/MR events with
  `parsePrWebhookEvent` (`apps/api/src/webhook-verify.ts`) and calls
  `planCommitForRepo` / `teardownAppPreviewForRepo`; the TTL sweep is
  `teardownExpiredAppPreviews` in the `app-reconcile` worker.

## File map

| Concern | Where |
|---|---|
| Repos / build core / registry enable / GC policy / live logs | `packages/trpc/src/services/cicd.service.ts` |
| GC pinned-set + plan execution (dispatch prune) | `packages/trpc/src/services/image-gc.service.ts` |
| Trivy scan, cosign keygen/sign/verify, policy | `packages/trpc/src/services/registryPolicy.service.ts` |
| Trivy DB cache (shared volume, stale fallback) + daily refresh | `packages/trpc/src/services/trivy-db{,.service}.ts`, worker `trivy-db-refresh` |
| System-image BOM + mirror + Hub pull-through cache | `packages/core/src/system-images.ts`, `packages/trpc/src/services/system-images.service.ts`, worker `system-image-mirror`, `apps/api/src/install/docker-registry-mirror.ts` |
| Offline bundle: BOM-driven image list, air-gapped install (`install-swarmy.sh --bundle`: verify, `docker load` by digest — needs the containerd image store), registry seed from the node's `swarmy-bundle` volume | `packages/core/src/platform-bundle-plan.ts`, `scripts/platform-bundle.ts`, `scripts/install-swarmy.sh` (`bundle_*`), `packages/core/src/system-images-bundle.ts`, `packages/trpc/src/services/system-images-bundle.service.ts`, worker `bundle-seed` |
| Registry reachability (M16): loopback forwarder spec, agent supervisor, topology rule + migration reconcile | `packages/core/src/registry-forwarder.ts`, `apps/agent/src/handlers/registry-forwarder.ts`, `packages/trpc/src/services/registry-topology{,.service}.ts` (ticked by `system-image-mirror`) |
| Image admission decision (pure + evaluator) | `packages/trpc/src/services/admission-images.ts` |
| Previews (PR / branch / trial) | `packages/trpc/src/services/apps.service.ts` (`planCommit`, `createAppPreview`, `teardownAppPreview*`) |
| Build-log fan-out bus | `packages/trpc/src/services/build-log-bus.ts` |
| Railpack program + meta capture (agent) | `apps/agent/src/handlers/build.ts` (`renderRailpackSteps`, `parseBuildMeta`) |
| Builder/cache payload, cache refs + GC plan, wizard detection (pure) | `cicd.service.ts` `buildStrategyPayload`, `services/build-cache.ts`, `services/git-providers/detect-build.ts` |
| Third-party registry creds (match/test pure core; CRUD + JIT resolver; hub decorator) | `packages/core/src/image-ref.ts` (split + match, browser-safe), `packages/trpc/src/services/registry-credentials{,.service}.ts`, `registry-auth.ts` (`createRegistryAuthDecorator`), router `registryCredentials`, REST `routes/registry-credentials.ts`; UI `apps/app/src/components/ci/registry-credentials-{resolve,matcher,builtin}.ts(x)` |
| tRPC surface | `packages/trpc/src/routers/{cicd,registryPolicy,apps}.ts` |
| Agent: BuildKit build / image prune | `apps/agent/src/handlers/{build,prune}.ts` |
| Build gate (`env.BUILD_OVERRIDE` + `buildGateAllows`) + executor cases | `apps/agent/src/{env,executor}.ts`, `packages/core/src/types.ts` |
| Wire protocol (build/prune payloads + results) | `packages/core/src/protocol/build.ts` (+ `messages.ts`) |
| `CommandName` → wire `type` | `packages/trpc/src/hub/types.ts` (`COMMAND_PROTOCOL_TYPE`) |
| Git webhook receiver (HMAC verify → SYSTEM build / PR) | `apps/api/src/webhooks.ts` + `apps/api/src/webhook-verify.ts` |
| Background sweeps (GC / preview TTL) | `apps/api/src/workers/{image-gc,app-reconcile}.ts` |
| Prisma models | `packages/db/prisma/schema/cicd.prisma` (`GitRepo`/`Build`/`RegistryConfig`/`ImageGcPolicy`/`ImageScan`) |
| `/ci` workspace UI | `apps/app/src/routes/_authed/ci.tsx`; build logs (Follow, Only warnings, cached layers, digest + scan) `components/ci/{build-log-parse,build-log-toolbar,build-layers,build-image-card}.ts(x)`; Connect a repo wizard `components/ci/git-wizard.tsx` (+ `git-providers.ts`, `git-folder-tree.ts`) |
| Branch previews page (every preview, the rules read-only, the data story, a preview from any branch) | `routes/_authed/stacks/$name.config.previews.tsx` → `components/gitops/previews/*` (`previews-model.ts` pure + tested) |
| Environments side by side + promote as a plan; PR plan as a graph | `components/gitops/environments/*`, `components/gitops/plan-graph{,-model}.ts(x)` |
| git-apps: swarmy.yaml schema/parser/planner (pure) | `packages/app-config/src/*` (`plans/epic-git-apps.md`) |
| git-apps: provider clients (GitHub App, GitLab, Gitea/Forgejo, deploy keys, git.inspect program + its source scan) | `packages/trpc/src/services/git-providers/*` (`gitea{,-auth,-feedback}.ts`, `inspect-scan.ts`), Gitea connections `services/git-gitea.service.ts` |
| git-apps: connections, JIT credentials, commit feedback, browser bind | `services/git-{connections.service,credentials,feedback.service,browser-bind,connection-view}.ts`, `routers/gitConnections.ts` |
| git-apps: the GitOps loop (ledger, compose compiler, executor, planCommit/confirm/poll/drift, stale-push rule) | `services/apps/{live,compile,apply,stale-commit}.ts`, `services/apps.service.ts`, `routers/apps.ts`, `apps/api/src/workers/app-reconcile.ts` |
| git-apps: environments (clone, env layers, per-environment secrets) | `services/apps/{clone,env-layers,env-secrets,dashboard-envs}.ts`, `routers/apps-environments.ts`; pure `packages/app-config/src/{clone-env,env-layers}.ts` |
| git-apps: compose → swarmy.yaml (what didn't translate, why) and Convert to swarmy.yaml | `packages/app-config/src/from-compose{,-read,-env,-gaps}.ts`, `services/apps/convert.ts` (`apps.convertToConfig`) |
| git-apps: repo scan → drafted swarmy.yaml (detectors with `file:line` evidence) | `packages/app-config/src/scan/*`, `services/git-scan.ts` (`gitConnections.draftConfig`); local `packages/devkit/src/check/*` (`swarmy check`, MCP `check_repo`) |
| git-apps: webhooks (GitHub, GitLab, Gitea dialect), durable dedupe, OAuth/App callbacks | `apps/api/src/{webhooks,webhook-verify,webhook-gitea,webhook-dedupe,git-callback}.ts`; `GitWebhookDelivery` in `cicd.prisma` |

## Adding a build/registry capability (the recipe)

1. **Protocol**: add the payload + result to `packages/core/src/protocol/build.ts`
   with a `commandId`; wire it into the `ControllerToAgentMessage` union in
   `messages.ts`.
2. **Registry**: add the `CommandName` and its wire `type` to
   `COMMAND_PROTOCOL_TYPE` (`packages/trpc/src/hub/types.ts`).
3. **Executor**: add a `case` in `apps/agent/src/executor.ts` — gate anything
   build/prune-shaped behind `buildGateAllows` (reject `E_BUILD_DISABLED`), wrap
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
- Registry GC deletes manifests only from the plan above, so rollback and a
  fresh node's pull keep working: the live pinned set, each repo's kept builds
  and anything written in the last 24h survive. Its read-only window refuses
  pushes for about a minute (skipped while a build is pushing); a window a
  crash interrupted is healed on the next tick, and a login rotation is refused
  mid-window. Size + counts are measured by the scan (`cicd.getRegistryUsage`,
  in memory).
- Single-replica registry is a data-loss SPOT — treat it as cache-rebuildable
  (rebuild from git); document S3 storage for HA.
- Per-repo webhook secrets are minted and registered with the provider by the
  connection flow (`git-connections.service`) — never log them.
- Verify: `bun --filter @swarmy/trpc typecheck` and the pure-core tests
  (`image-gc.test.ts`, `admission-images.test.ts`,
  `prune.test.ts`, `registryPolicy.service.test.ts`) plus the protocol
  round-trip over `build.ts`. Multi-node: `scripts/local-vms.sh`
  (`skill("run-local")`) — toggle the Builder role on a node (or set
  `SWARMY_ALLOW_BUILD=true`), wire a repo, push, watch the build stream and the
  service redeploy to the new digest.
