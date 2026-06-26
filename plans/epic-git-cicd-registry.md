# Git integration, in-swarm CI runners, and local registry with image GC — Implementation Plan

## Problem

Today swarmy deploys images that already exist in some registry. The user still has to: wire up an external CI, build images, push them to Docker Hub / GHCR / a self-hosted registry, manage registry credentials, and manually bump the image tag in swarmy to deploy. That breaks the "anyone can just deploy" promise. This epic closes the loop so that **a `git push` becomes a running, healthy service** with zero external infrastructure:

1. **Link a git provider** (GitHub/GitLab/Gitea/Bitbucket) and **watch repos** for pushes/tags.
2. **Build images on swarm nodes** that match operator-chosen labels (so builds run on beefy/spot nodes, never on a tiny manager), using a runner that rides alongside the existing per-node agent.
3. **Push to a registry that runs inside the swarm**, replicated and reachable by every node via an overlay network, secured, with no public exposure required.
4. **Apply retention/GC** so disks don't fill: prune old images, but **never** prune the digest currently running in prod (so a freshly-joined or rescheduled node can still pull it), and support "promote on healthcheck" GC (delete the previous image once the new one passes health).
5. Wire all of this into the existing **deployments** pipeline and the **GUI builder**.

Hard constraints from swarmy's architecture: the controller never touches a node's Docker socket; the agent dials out and applies generic *intent*; everything is org-scoped, audited, and pluggable/disableable; and it must stay one-command / zero-config.

## Recommended approach

### Build execution: BuildKit (`buildkitd`) as a swarm service, driven by the agent as a new capability — NOT shelling out to `docker build`

Run **`moby/buildkit:rootless`** as a swarm service constrained to builder-labeled nodes, and have the node agent talk to its **local `buildkitd`** over the BuildKit gRPC API (via the `buildctl` binary bundled into the agent image, or `buildkit` Go client invoked as a subprocess). Why BuildKit specifically:

- **It is the engine inside `docker build` already** — same Dockerfile semantics, so user repos build identically with or without swarmy (the unopinionated requirement). No bespoke build DSL.
- **Cache + concurrency + secrets**: BuildKit gives content-addressed layer cache (can be exported to the in-swarm registry as cache images), parallel stages, and `--secret`/`--ssh` mounts so private deps and git SSH keys never bake into layers.
- **Rootless mode** avoids handing builds a privileged daemon, which matters because build = arbitrary code execution from a repo.
- **It already speaks "push to registry"** as a build output (`--output type=image,push=true`), so build and push are one step with one digest result — exactly the digest we then feed to deploy and to GC's "in prod" reasoning.

The agent gets **one new capability, `buildImage`**, that wraps `buildctl build`. This fits the existing model perfectly: the agent already "applies generic intent and reports a commandResult"; a build is just a longer-running command that streams `logChunk`s (reusing the exact log-streaming machinery already built for `streamLogs`) and ends in a `commandResult` carrying `{ imageRef, digest }`.

**Alternatives weighed:**
- *`docker build` via the agent's dockerode/CLI* — simplest, but couples builds to the node's main Docker daemon (no rootless isolation, weaker cache control, and on a manager that's dangerous). Rejected.
- *Kaniko* — daemonless, good for k8s, but no shared persistent cache story without external cache registry plumbing, and it's clunky to keep warm. BuildKit's persistent `buildkitd` with a cache volume is simpler and faster for the "watch a repo, rebuild often" loop. Kaniko stays as a *possible second driver* (see pluggability).
- *Depot/Namespace/cloud builders* — great, but external paid infra; violates zero-infra and self-hostability. Could be a future "build driver" plugin for the hosted cloud tier.

Builds are modeled behind a **`BuildDriver` registry** mirroring the existing `IngressRegistry` (`buildkit` | `kaniko` | `external`), so "new builder" = new driver, not an agent rewrite.

### Registry: `distribution/registry` (CNCF Distribution v3) in-swarm, fronted by the existing ingress, with `zot` as the upgrade path

Deploy **CNCF `registry:3` (Distribution)** as a swarm service for MVP. Why:

- **Tiny, boring, battle-tested**, single static binary, the reference OCI registry. Zero-config to stand up.
- Supports **filesystem storage** (a named volume) for single-node and **S3/MinIO** storage for HA — so the same component scales from a hobby box to replicated.
- Has a **built-in GC** (`registry garbage-collect`) for blob-level cleanup, complementing our tag-level GC policy engine.

**Deployment shape:** one swarm service `swarmy-registry` on a swarmy-managed overlay network `swarmy` (the same network ingress already assumes — see `IngressGlobalOptions.network` default `"swarmy"`). It's reachable cluster-wide at `registry.swarmy.local:5000` (or a swarm-DNS service name), so **every node pulls over the overlay without the registry ever being public**. Auth via **htpasswd basic-auth bootstrapped by swarmy** (token stored in db, injected as a docker secret); TLS terminated by the existing Caddy/Traefik ingress driver, or skipped intra-overlay with `insecure-registries` configured on nodes by the agent.

**Replication:** MVP = single replica + volume on one storage-labeled node (constraint-pinned). Later = either (a) shared object storage (MinIO/S3) with N replicas, or (b) `registry`'s pull-through/proxy. Harbor is explicitly **rejected for the default** — it's a multi-container Postgres+Redis+Trivy stack, the opposite of one-command. `zot` is the planned **second driver** (OCI-native, built-in dedup, optional Trivy CVE scanning, sync/mirroring) for users who want vulnerability scanning and a nicer API; it slots into the same `RegistryDriver` registry.

### Git linking: webhooks first, poll as automatic fallback

- **Webhooks** are the primary trigger: low latency, no token-scope polling, and GitHub/GitLab/Gitea/Bitbucket all send a signed push/tag payload. The controller exposes `POST /webhooks/git/:repoConnectionId`, verifies the provider HMAC signature, and enqueues a build.
- **Polling** is the fallback for repos behind NAT or where the user can't add a webhook (the controller can't always be reached either). A worker polls `GET refs` on an interval per repo and diffs the last-seen SHA.
- **Auth**: GitHub App / OAuth installation token where possible (fine-grained, short-lived); PAT/deploy-key as the simple path. Better Auth already manages OAuth `Account` rows — reuse its provider token storage for GitHub/GitLab login-linked tokens; store repo-scoped deploy keys/PATs encrypted in a new `GitConnection` model.

### GC policy engine: runs on the controller, reasons over the deployments table; executes via agent + registry API

The **policy decision** lives in the controller (it's the only place that knows org-wide "what's deployed where" via the `deployments`/`services` tables and live `serviceState` snapshots). The **policy actions** (delete manifest in registry, prune image on a node) are dispatched as commands. This keeps GC logic testable and centralized while honoring "controller never touches a socket." "In prod" = the set of image digests referenced by any `Service.image`/latest successful `Deployment.imageDigest` across the org — those digests are **pinned** and never collected.

## Architecture & integration

### New protocol messages (`packages/core/src/protocol/`)

New file `build.ts`, added to both discriminated unions in `messages.ts` and to `COMMAND_PROTOCOL_TYPE` / `DEFAULT_COMMAND_TIMEOUTS`:

- **Controller→agent commands:**
  - `buildImage` — `{ ...cmd, source: GitSource | { kind: 'inline', context, dockerfile }, imageRefs: string[], buildArgs?, secrets?: BuildSecretRef[], target?, platforms?: string[], cacheFrom?, cacheTo?, registryAuth?: RegistryAuth, pushPolicy: 'always'|'never' }`. `GitSource = { kind:'git', url, ref, subdir?, authRef? }`. Long-running; streams `logChunk` keyed by `commandId` (reuse existing log plumbing verbatim); terminal `commandResult.result: { digest, imageRefs, sizeBytes, cacheHit }`.
  - `pruneImages` — `{ ...cmd, keepDigests: string[], strategy: 'dangling'|'until'|'all-except-keep', untilDays?, dryRun? }`. The "keep" list is the controller-computed pinned set. Result: `{ removed: string[], reclaimedBytes }`. Maps to `docker image prune`/targeted `docker rmi` via dockerode (extend `DockerClient`).
  - `registryGc` — `{ ...cmd, deleteManifests: string[], runBlobGc: boolean }` dispatched to the node hosting `swarmy-registry`; deletes manifests via the **registry HTTP v2 API** (`DELETE /v2/<name>/manifests/<digest>`) then optionally triggers blob GC.
- **`CommandResultMap` additions** (`results.ts`): `buildImage`, `pruneImages`, `registryGc` typed results.
- **`CommandName`** additions in `packages/trpc/src/hub/types.ts`: `image.build`, `image.prune`, `registry.gc`, with their `COMMAND_PROTOCOL_TYPE` mappings.

A `BuildSecretRef`/`authRef` is an **indirection** — the wire never carries raw secrets in the build command's persisted form; the controller injects the actual secret value at dispatch time (or, better, the agent fetches it via a short-lived scoped grant), and audit logs reference the id only.

### New db models (`packages/db/prisma/schema.prisma`)

- `GitProvider` enum (`GITHUB|GITLAB|GITEA|BITBUCKET|GENERIC`) and `BuildStatus` enum.
- **`GitConnection`** — orgId, provider, displayName, accountId (link to Better Auth `Account` when OAuth), encrypted token/deploy-key, webhookSecret, createdBy. Org-scoped.
- **`Repo`** — orgId, gitConnectionId, remoteUrl, defaultBranch, watch config (`triggerOn: push|tag|pr`, branch/tag globs, build context subdir, Dockerfile path), pollIntervalSec (nullable = webhook-only). Unique `[orgId, remoteUrl]`.
- **`Build`** — orgId, repoId, commitSha, ref, triggeredBy (`webhook|poll|manual`), nodeId (where it ran), status (`QUEUED|BUILDING|PUSHING|SUCCEEDED|FAILED|CANCELED`), imageRef, imageDigest, logsRef, startedAt/finishedAt, commandId. Indexed `[orgId, startedAt]`, `[repoId, startedAt]`. **`Build.imageDigest` becomes the bridge to `Deployment.imageDigest`** (already exists in schema).
- **`RegistryConfig`** — orgId (unique), driver (`distribution|zot|external|none`), enabled, endpoint, storageNodeId/storageMode (`volume|s3`), settings JSON, credentials (secret ref). Mirrors `IngressConfig` exactly.
- **`GcPolicy`** — orgId, scope (`org|repo|service`), targetId, mode (`keep-n-per-repo|until-days|on-healthcheck-promote`), params JSON (`keepN`, `untilDays`), pinProd (bool, default true), enabled, schedule. Plus optional `pinnedDigests` denormalized cache.
- Add `Build[]` / `repoId?` relations to `Deployment` so a deployment can record "built from build X".

### New tRPC routers + services (`packages/trpc/src/`)

Add to `root.ts`: `git`, `builds`, `registry`, `gc`.

- **`git` router** — `connections.{list,create,test,delete}`, `repos.{list,add,update,remove}`, `repos.detectDockerfile` (clones shallow on a builder node, lists candidate Dockerfiles for the GUI), `webhookUrl` (returns the per-repo URL + secret to paste into the provider). Service layer verifies provider tokens.
- **`builds` router** — `list`, `get`, `trigger` (manual build of a ref), `cancel`, `logs` (subscription — reuses `ctx.hub.subscribeLogLines` against the live build `commandId`), `logsPage` (historical, from `logsRef`). `build.service.ts` resolves a **builder node by label**, dispatches `image.build`, persists the `Build`, and on success can chain into a deployment.
- **`registry` router** — `get/configure/enable/disable`, `status` (queries the registry `/v2/` over the agent), `repositories`/`tags` (catalog browse), `credentials.rotate`. `registry.service.ts` deploys/updates the `swarmy-registry` swarm service via the existing `service.deploy` command path (the registry is just a swarm service swarmy manages).
- **`gc` router** — `policies.{list,upsert,delete}`, `previewPlan` (dry-run: compute what *would* be deleted given current pinned set), `runNow`. `gc.service.ts` holds the **policy engine** (pure functions: given builds + pinned digests + policy → delete/keep plan) so it's unit-testable.

Audit: every connect/build/configure/gc action writes `AuditLog` with `actorType` `user` or `system` (poll/webhook builds are `system`), consistent with the existing pattern.

### New agent capabilities (`apps/agent/src/`)

Extend `executor.ts`'s `handleCommand` switch with `buildImage`, `pruneImages`, and (registry-host node) `registryGc`. New `apps/agent/src/build.ts`:
- Detects local `buildkitd` (env `SWARMY_BUILDKIT_ADDR`, default `unix:///run/buildkit/buildkitd.sock`); if absent and the node is a builder, the agent ensures the buildkit service/container is reachable (it's scheduled by the controller, not self-started, to keep the agent dumb).
- Runs `buildctl build` for the git/inline source, streams stdout/stderr as `logChunk`s through the existing `conn.send('logChunk', …)` path, exports to the in-swarm registry with `--output type=image,push=true`, parses the resulting digest.
- Git fetch uses a shallow clone with the `authRef`-resolved credential mounted as a BuildKit `--ssh`/`--secret`, never written to a layer.
- Gated like exec: builds only run on nodes that opted in (`SWARMY_ALLOW_BUILD=true` + a builder label), and the agent refuses otherwise with `E_BUILD_DISABLED`.

Extend `DockerClient` (`packages/core/src/docker.ts`) with `pruneImages(keepDigests, opts)`, `listImagesWithDigests()`, and `removeImage(id)` for the GC executor.

### Label-based scheduling

Two layers, both reusing what exists:
- **Where buildkit/registry run**: swarm placement constraints. The controller adds `node.labels.swarmy.role=builder` / `=registry-storage` via the existing `updateSwarmNode` command (which already sets node labels), and the `swarmy-registry`/`buildkit` services are created with `constraints: ["node.labels.swarmy.role==registry-storage"]` through the existing `ServiceSpec.constraints` path.
- **Which node a given build dispatches to**: a new `resolveBuilderNode(ctx, {labelSelector})` in `dispatch.service.ts` mirroring `resolveManagerNode` — picks an online node whose `Node.labels` match the build's selector, load-balancing by in-flight build count.

### GC policy engine placement & "in prod" reasoning

Runs as a **new controller worker** (`apps/api/src/workers/image-gc.ts`, registered in `workers/index.ts` beside `startRetention`) plus on-demand via `gc.runNow`. Each cycle, per org:
1. Compute the **pinned set** = distinct `imageDigest` of every service's current desired image + the latest `SUCCEEDED` deployment digest per service + the live `serviceState` running digests from `ctx.hub` snapshots. This is the "never delete what prod can pull" guarantee, including for nodes that haven't joined yet (the digest stays in the registry, so a new node pulls it).
2. Apply each `GcPolicy`: `until-days` keeps everything newer than N days **except** still subtract-protected by the pinned set; `keep-n-per-repo` keeps the N most recent builds per repo plus pinned; `on-healthcheck-promote` deletes the *previous* image only after the new deployment's healthcheck passes (it watches `Deployment.phase === COMPLETE` + service `RUNNING`/`runningReplicas==desired` before collecting the predecessor).
3. Emit a plan → dispatch `registryGc` (manifest deletes + blob GC) to the registry node and `pruneImages(keepDigests=pinned)` to each node to reclaim local disk.

### UI surfaces (`apps/app/src/routes/_authed/`)

- **`/git`** — connections + watched repos; "Add repo" wizard (pick connection → repo → branch/tag globs → Dockerfile path auto-detected → "build on nodes labeled ___").
- **`/builds`** — build history table + live build log viewer (reuse the existing log-streaming component used for service logs).
- **`/registry`** — enable toggle, storage node picker, catalog browser (repos/tags/sizes), credentials.
- **`/settings/gc`** — policy editor with a **dry-run "preview plan"** showing exactly what gets deleted and what's pinned (and *why* — "running in prod on node-2").
- **GUI service builder integration**: in the existing create/update-service form, the **image field gets a "Build from git" tab** — selecting a repo+ref creates a `Build`, and on success auto-fills the resulting `<registry>/<repo>@<digest>` and deploys. The "deploy on push" toggle on a `Repo` links a watched repo directly to a service so a `git push` redeploys it.

## MVP vs later

**MVP (phase 1 — closes the loop):**
- `GitConnection` + `Repo` with **PAT/deploy-key** auth (skip GitHub App).
- **Webhook trigger** for GitHub + GitLab (HMAC verified); manual `builds.trigger`.
- `buildImage` agent capability via **BuildKit rootless**, single platform, push to registry, live logs.
- **`registry:3` single-replica** on a volume on one storage-labeled node, basic-auth, intra-overlay (insecure-registry on nodes), no public exposure.
- Label-targeted builder selection.
- **GC: `keep-n-per-repo` + `until-days` with `pinProd`** via the controller worker; manifest delete + node prune.
- GUI: `/builds` list+logs, `/registry` enable+catalog, "Build from git" tab in the service builder.

**Phase 2:**
- Polling fallback; GitHub App / OAuth-token reuse via Better Auth; Gitea/Bitbucket.
- `on-healthcheck-promote` GC mode (needs deployment-health watching wired to GC).
- BuildKit registry-exported cache (`cacheTo/cacheFrom type=registry`); multi-arch (`--platform`, emulation/multi-node).
- Registry TLS via ingress driver; S3/MinIO storage + N replicas (HA); registry blob GC scheduling.
- "Deploy on push" auto-redeploy linking repo→service.

**Phase 3 / enterprise + hosted:**
- `zot` driver with Trivy CVE scanning + sync; Kaniko/Depot build drivers; build secrets vault; signed images (cosign) + admission ("only deploy signed digests"); pull-through cache of upstream registries; hosted multi-tenant shared registry.

## Dependencies

- **Deployments pipeline** (exists): `Deployment.imageDigest` and the deploy command path are the consumers of build output and the source of "in prod" truth. GC's correctness depends on deployments recording the digest reliably — verify the deploy flow persists `imageDigest` from the `pullImage`/`deployService` result.
- **Ingress epic** (exists): TLS-fronting the registry and any future public build artifacts reuse the `IngressDriver` pipeline and the shared `swarmy` overlay network.
- **Node labels / `updateSwarmNode`** (exists): required for placement and builder selection.
- **Secrets handling**: needs a small encrypted-secret facility for git tokens, registry creds, and build secrets. No such model exists yet — introduce a minimal `Secret`/credential-ref pattern (could be its own micro-epic; MVP can use app-level encryption with `BETTER_AUTH_SECRET`-derived key + docker secrets for the registry htpasswd).
- **Infra**: BuildKit and the registry images need to be pullable on first run (chicken-and-egg if the only registry is the one we're deploying — bootstrap from Docker Hub/GHCR public images).

## Risks & open questions

- **Build = arbitrary code execution from a repo.** Rootless BuildKit + label-isolated builder nodes + no Docker socket exposure is the mitigation, but multi-tenant hosted needs stronger isolation (per-build ephemeral buildkitd, network egress policy). Open: do we ever allow builds on manager nodes? (Default: no.)
- **insecure-registry over overlay**: shipping with insecure intra-overlay registry is the zero-config default but requires the agent to edit `/etc/docker/daemon.json` + restart dockerd, which is invasive. Alternative: registry behind ingress TLS from day one — more setup, safer. Open question; lean toward **TLS-by-default once ingress is configured, insecure only as an explicit opt-in for a single-node hobby setup.**
- **Single-replica registry is an availability + data-loss SPOT.** A node failure loses unbuilt-elsewhere images. Mitigate by treating the registry as cache-rebuildable (you can always rebuild from git) and documenting S3 storage for anyone who cares.
- **GC racing a deploy**: a build/deploy in flight could reference a digest not yet pinned. Mitigation: a **grace window** (don't collect anything newer than X minutes / referenced by a non-terminal deployment) and compute the pinned set inside the same transaction snapshot.
- **Webhook reachability**: controller must be publicly reachable for webhooks; many self-hosters aren't. Polling fallback covers it but adds latency and token-scope needs.
- **Digest vs tag drift**: must deploy by **digest**, not floating tag, or GC's "in prod" and rollback break. Enforce digest-pinning end to end.
- **BuildKit cache growth** is itself a disk consumer — GC must also prune the build cache volume, not just images.

## Simplicity note

The whole epic is designed to collapse into **one button and zero config**:

- **Zero-infra**: enabling the registry is a single toggle that deploys one swarm service swarmy already knows how to manage; no Postgres/Redis/extra stack (that's why Distribution over Harbor). BuildKit is one more swarm service swarmy schedules.
- **Auto-detection**: the add-repo wizard auto-detects the Dockerfile and default branch, so the user picks a repo and clicks "Build & Deploy."
- **Sane defaults that just work**: builds land on any node by default (label-targeting is opt-in for power users), `pinProd` is on by default so GC can never delete a running image, and GC defaults to a conservative `keep-n + until-days` that a user never has to think about.
- **Unopinionated**: builds are plain Dockerfiles via BuildKit — repos build identically with or without swarmy, and images live in a standard OCI registry any tool can pull from. Nothing locks the user in.
- **One mental model**: a build is just another long-running agent command that streams logs and returns a digest — same dispatch/result/log machinery as everything else, same audited org-scoped surface, every piece individually disableable (registry/builds/gc each behind an enable flag like ingress).

Key integration files for the implementer: protocol in `/home/user/swarmy/packages/core/src/protocol/` (new `build.ts`, edit `messages.ts`, `results.ts`, `constants.ts`); command map in `/home/user/swarmy/packages/trpc/src/hub/types.ts`; agent executor `/home/user/swarmy/apps/agent/src/executor.ts` (+ new `build.ts`); docker wrapper `/home/user/swarmy/packages/core/src/docker.ts`; driver-registry pattern to mirror at `/home/user/swarmy/packages/ingress/src/registry.ts`; new routers wired in `/home/user/swarmy/packages/trpc/src/root.ts`; GC worker beside `/home/user/swarmy/apps/api/src/workers/retention.ts`; schema at `/home/user/swarmy/packages/db/prisma/schema.prisma`.
