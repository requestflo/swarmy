# CI/CD & registry — "git push, and it's live — no external CI"

**Status: canonical product design (2026-07). Pairs with the `cicd-registry`
skill for the how.**

## The feeling we are building

Someone who has a swarm and a git repo should never leave swarmy to ship. No
GitHub Actions runner to configure, no Docker Hub account, no `docker push`, no
copying an image tag back into a deploy field. The `/ci` workspace opens on a
coral **"4 repos wired."** and the promise underneath it: *"Connect a repo with a
swarmy.yaml, build on your nodes, push to a registry that lives inside the swarm.
No external CI."*

1. They flip on the **in-swarm registry** — one toggle stands up a single
   `registry:2` service on the `swarmy` overlay. *"Every node pulls over the
   network — never public."* No credentials to a third party, no public
   surface.
2. They **connect a repo** through the New app wizard (GitHub App, GitLab OAuth
   or a generic SSH URL). The repo's swarmy.yaml describes the app; a compose-only
   repo gets a converted starter to commit.
3. They push. The webhook fires, a **BuildKit build runs on their own node**,
   the image is pushed to the in-swarm registry, and the app's plan **deploys the
   freshly-built digest**, no tag typed anywhere.
4. Every successful build is **CVE-scanned by Trivy automatically**; with
   signing on, images are **cosign-signed** and the org can refuse to deploy
   anything unsigned or critical. *"Only deploy signed images — valid cosign
   signature. Fails closed."*
5. Open a pull request and it gets **its own throwaway copy at
   `pr-<N>.your-domain`**; merge or abandon it and *"merged or stale previews
   tear themselves down."*
6. Disks never fill: GC *"reclaims disk — but never deletes a digest that's
   running in prod."*

It should feel like the swarm grew a CI pipeline of its own — because it did.
The controller still never touches a node's Docker socket; a build is just a
longer-running agent command that streams logs and returns a digest.

## How it works (git push → running service)

```
git push / open PR                                dashboard: /ci "New app from Git"
   │  POST /webhooks/git/<repoId>   (controller = the only public surface)
   │     verify HMAC (GitHub X-Hub-Signature-256 / GitLab X-Gitlab-Token)
   ▼
controller resolves the GitRepo → SYSTEM build (audited actorType:system)
   │  ① resolve an online BUILDER node (swarmy.node.builder=true; none → actionable error)
   │  ② dispatch image.build { source, imageRefs, registryAuth, builderCapable } → that node
   ▼
agent (Builder role, or SWARMY_ALLOW_BUILD=true): moby/buildkit:rootless + buildctl
   │  ③ shallow-clone → build Dockerfile → --output type=image,push=true,registry.insecure=true
   │     (builder on the host network; rootlesskit buildkitd; workspace under $HOME)
   │     logChunk stream keyed by commandId (== Build.logsRef) → live viewer
   ▼
in-swarm registry  localhost:5000  (single registry:2, port 5000 on the routing mesh)
   │  ④ digest parsed from containerimage.digest → Build row SUCCEEDED
   │  ⑤ Trivy scan + cosign sign (fire-and-forget); admission gates future deploys
   ▼
git-app plan applies: services pinned to host/name@sha256:…   → the app is live
   │  PR path instead → the swarmy.yaml preview environment
   ▼
image GC worker pins every in-prod digest; prunes the rest on your nodes
```

Four ideas, one story:

- **A build is just another agent command.** `image.build` and `image.prune`
  are one entry each in the protocol, the `CommandName` registry, and the
  executor — same dispatch/result/log machinery as deploy or backup. Builds run
  on the agent against its LOCAL Docker socket, streaming the exact `logChunk`
  frames service logs use. See `skill("agent-handlers")`.
- **The registry is a swarm service swarmy manages.** Enabling it is one
  `service.deploy` of `registry:2`, replicas 1, on the shared `swarmy` overlay,
  with port 5000 published on the swarm routing mesh — so it answers at
  `localhost:5000` on EVERY node. Docker trusts 127.0.0.0/8 registries as
  insecure by default, so every node's dockerd pulls plain-HTTP with zero daemon
  config. (The overlay name `swarmy-registry:5000` only resolves inside
  containers on the overlay — node dockerd can never pull it; it is still
  recognised as an org-registry prefix for legacy refs.) Port 5000 must be
  firewalled from outside the swarm. Images live in a standard OCI registry any
  tool can pull from — no lock-in.
- **Deploy by digest, never by tag.** Every build resolves to
  `host/name@sha256:…`, and deploys pin that digest. This is what makes GC's
  "in prod" reasoning and rollback correct — a floating tag would break both.
- **The controller is the only public door.** Webhooks land on the controller
  (HMAC-verified per repo); the build, the push, and the pull all happen inside
  the swarm. Nothing on a node needs an inbound port.

## Roles and where truth lives

- **What is "in prod" is Docker truth, read live.** The GC pinned set is
  computed from the hub's live inventory — every running service's resolved
  `@sha256` image plus every running container's pulled digest — never from a
  `Service`/`Deployment` DB row. A digest a node is running (or could pull) is
  never collected. See `skill("docker-native-storage")`.
- **The registry and the builder are Docker-native.** The registry is a swarm
  service; a builder is any node carrying the `swarmy.role=builder` label.
  Previews are git-app environments (see `epic-git-apps.md`): their plans are
  `AppPlan` history, their running state is the preview stack itself.
- **The DB owns swarmy's own identity, config, secrets, and queryable history**:
  `GitRepo` (repo input config + vault-encrypted git token & webhook secret +
  `previewsJson`), `Build` (the bridge row: which build produced which digest,
  its ref/status/logsRef/timing), `RegistryConfig` (enable flag, host, encrypted
  registry creds, the admission toggles, and the org's cosign keypair —
  **private key vault-encrypted with `SWARMY_SECRET_KEY`, never returned to a
  client**), `ImageGcPolicy`, and `ImageScan` (Trivy scan history + CVE report).

## CI/CD & registry behaviour

- **Builds run only where opted in.** "Builder" is a node role (the
  `swarmy.node.builder` Docker node label, toggled in the node's role
  switches; the legacy `swarmy.role=builder` still counts). The controller only
  dispatches builds/GC to builder-capable nodes and asserts it in the payload
  (`builderCapable`); the agent refuses otherwise with `E_BUILD_DISABLED`. A
  single-node org's first node gets the role automatically on install.
  `SWARMY_ALLOW_BUILD` in the node's agent.env stays an explicit local override
  (`true` forces on, `false` vetoes even when the role is on), reported to the
  controller in the register facts. Build = arbitrary code from a repo, so it runs in
  rootless BuildKit, never against the node's main daemon privileged.
- **No Dockerfile? It still builds.** A repo without a Dockerfile (Node, Python,
  Go, Ruby, PHP, Rust, Elixir, static…) is built with Railpack, Railway's
  open-source builder, on the same rootless BuildKit: `railpack prepare` runs
  inside BuildKit and writes a plan, then the pinned Railpack frontend builds
  it. `build.type` in swarmy.yaml forces `dockerfile` or `railpack`; absent,
  the Dockerfile wins when there is one. `install` / `build` / `start` /
  `packages` / `apt` / `build_apt` / `env` override what Railpack detects;
  build env reaches the build as BuildKit secrets, never a layer. The "New app
  from Git" wizard previews the result ("Detected: Next.js · Node 22 · start:
  npm run start") with the port and health path to use; the build log shows
  Railpack's own plan, and the Build records what it actually detected.
- **Builds are warm from the registry.** Every build exports its BuildKit cache
  (`mode=max`) to `<image>:buildcache-<key>-<branch>` in the in-swarm registry
  and imports its branch's cache, then the default branch's. A missing cache is
  a cold build, and a failed export never fails the build. Stale or excess
  cache refs are deleted by the image-GC tick (default: unused 14 days, 20 GB),
  never an image digest.
- **Secrets are resolved just-in-time and never baked in.** Git tokens and
  registry creds are stored encrypted, decrypted at dispatch, passed as a git
  auth header / one-shot Docker config inside the builder container, and never
  written into an image layer or returned to the client. The webhook secret
  leaves the controller exactly once — when the operator asks for the URL to
  paste into the provider.
- **Every successful build is scanned, and optionally signed.** Trivy runs
  fire-and-forget on the building node; it never delays or fails the build.
  Counts land on an `ImageScan` (critical/high/medium/low, `passed|failed|
  error`). With signing enabled, cosign signs the pushed digest with the org key.
- **Admission gates deploys, not builds.** With `blockCriticalCves`, a deploy of
  an org-registry image with critical CVEs is **blocked** (`images/critical-cves`)
  and a never-scanned image **warns** (`images/unscanned`). With
  `requireSignedImages`, an unsigned image is **blocked** (`images/unsigned`) and
  a signature that cannot be verified **fails closed**. Third-party public images
  are out of scope; verification is memoized per digest for 10 minutes.
- **A compose repo gets a swarmy.yaml for free.** When the New app wizard finds
  a compose file and no swarmy.yaml, it shows a converted starter
  (`@swarmy/app-config` `composeToAppConfig`): postgres/redis/meilisearch/qdrant/
  minio services become managed resources and the env vars pointing at them
  become bindings; anything it can't carry over is listed in plain words.
- **Previews come from swarmy.yaml and tear themselves down.** A PR, an opted-in
  branch, or a trial deploy (`swarmy deploy --preview`) plans the branch's
  swarmy.yaml as its own preview environment (own stack, own URL under
  `previews.base_domain`, optionally a scrubbed data copy). Closing the PR or
  deleting the branch tears it down; `app-reconcile` removes anything past
  `previews.ttl`.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| No builder node online | `triggerBuild` fails fast (no `Build` row) with an actionable message: which builder is offline, or how to enable one (Builder role / `SWARMY_ALLOW_BUILD=true`). Never dispatched to a non-builder node. |
| Railpack can't plan the repo | `railpack prepare` exits 1 (transient exit 75 is retried): the build fails with Railpack's own reason and "add a Dockerfile, or set build.start". |
| Build cache missing or registry cache export fails | Cold build (import is skipped with a log line); `ignore-error` on export means the build still succeeds. |
| Build fails (bad Dockerfile, clone error) | Non-zero build exit → `commandResult` failed → `Build` row `FAILED`, full log retained in the live viewer; nothing is deployed. |
| GC racing a running service | The pinned set is computed from LIVE running digests each cycle, so a digest in use is never in the remove set; the agent ALSO refuses to delete a pinned digest (defence in depth) and `repoPrefix`-scopes to swarmy-pushed images only. |
| Registry node down | Enable status shows `online:false`; builds can't push and fail cleanly. The registry is cache-rebuildable — you can always rebuild from git (S3 storage documented for anyone who needs HA). |
| Webhook with a bad signature | HMAC/token verification fails → `401`, no build. Pings and non-watched branches are acknowledged and ignored. |
| Unsigned / critical-CVE image at deploy | Admission blocks with a plain-words reason and an audited override path; signing-not-verifiable fails closed rather than waving it through. |

## Explicitly rejected

- **An external CI (GitHub Actions / GitLab CI / a hosted builder).** It breaks
  the "anyone can just deploy" promise and pushes secrets and build minutes off
  the swarm. Builds ride the same agent the swarm already trusts.
- **`docker build` on the node's main daemon.** Couples builds to the privileged
  engine (dangerous on a manager) with weaker cache/isolation. Rootless BuildKit
  on a labeled builder node is the isolation boundary.
- **Harbor (or any Postgres+Redis+Trivy registry stack) as the default.** It is
  the opposite of one-command; `registry:2` is a single boring binary. `zot`
  with built-in scanning is the planned second driver, not the floor.
- **A DB mirror of "what's in prod."** GC's correctness comes from reading live
  running digests, not a shadow table that drifts. See the `docker-native-storage`
  skill.
- **Deploying by floating tag.** `:latest` moving under you breaks rollback and
  GC's pinning; swarmy pins `@sha256:…` end to end.
- **Publishing preview ports.** A preview must never fight prod (or another
  preview) over host ports; the `pr-<N>` route is the single front door and
  everything else stays on the overlay.

## Implementation map

The invariants and file map live in the `cicd-registry` skill
(`.claude/skills/cicd-registry/SKILL.md`) — how a build/prune command, the
registry service, the scan/sign path, and previews fit together. Key homes:
`packages/trpc/src/services/cicd.service.ts` (repos, build core, registry
enable, GC policy, live logs), `packages/trpc/src/services/image-gc.service.ts`
(pinned-set + plan execution), `packages/trpc/src/services/registryPolicy.service.ts`
+ `admission-images.ts` (Trivy scan, cosign sign/verify, admission),
`packages/trpc/src/services/apps.service.ts` (swarmy.yaml plans, incl. previews),
`packages/trpc/src/routers/{cicd,registryPolicy,apps}.ts` (the tRPC surface),
`apps/agent/src/handlers/{build,prune}.ts` +
`packages/core/src/protocol/build.ts` (the agent capability),
`apps/api/src/webhooks.ts` (the git webhook receiver),
`apps/api/src/workers/{image-gc,app-reconcile}.ts` (the background sweeps),
`packages/db/prisma/schema/cicd.prisma` (the models), and
`apps/app/src/routes/_authed/ci.tsx` (the `/ci` workspace).
