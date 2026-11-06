# CI/CD & registry — "git push, and it's live — no external CI"

**Status: canonical product design (2026-07). Pairs with the `cicd-registry`
skill for the how.**

## The feeling we are building

Someone who has a swarm and a git repo should never leave swarmy to ship. No
GitHub Actions runner to configure, no Docker Hub account, no `docker push`, no
copying an image tag back into a deploy field. The `/ci` workspace opens on a
coral **"4 repos wired."** and the promise underneath it: _"Connect a repo with a
swarmy.yaml, build on your nodes, push to a registry that lives inside the swarm.
No external CI."_

1. They flip on the **in-swarm registry** — one toggle stands up a single
   `registry:2` service on the `swarmy` overlay. _"Every node pulls over the
   network — never public."_ No credentials to a third party, no public
   surface.
2. They **connect a repo** through the New app wizard (GitHub App, GitLab OAuth,
   Gitea / Forgejo, or a generic SSH URL). The repo's swarmy.yaml describes the
   app; a compose-only repo gets a converted starter to commit, and a repo with
   neither gets one drafted from what its code needs.
3. They push. The webhook fires, a **BuildKit build runs on their own node**,
   the image is pushed to the in-swarm registry, and the app's plan **deploys the
   freshly-built digest**, no tag typed anywhere.
4. Every successful build is **CVE-scanned by Trivy automatically**; with
   signing on, images are **cosign-signed** and the org can refuse to deploy
   anything unsigned or critical. _"Only deploy signed images — valid cosign
   signature. Fails closed."_
5. Open a pull request and it gets **its own throwaway copy at
   `pr-<N>.your-domain`**; merge or abandon it and _"merged or stale previews
   tear themselves down."_
6. Disks never fill: GC _"reclaims disk — but never deletes a digest that's
   running in prod."_

It should feel like the swarm grew a CI pipeline of its own — because it did.
The controller still never touches a node's Docker socket; a build is just a
longer-running agent command that streams logs and returns a digest.

## How it works (git push → running service)

```
git push / open PR                                dashboard: /ci "New app from Git"
   │  POST /webhooks/git/<repoId>   (controller = the only public surface)
   │     verify HMAC (GitHub X-Hub-Signature-256 / GitLab X-Gitlab-Token /
   │     Gitea X-Gitea-Signature), then drop a delivery already seen
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
in-swarm registry  localhost:5000  (single registry:2 on the encrypted swarmy overlay; each node's loopback forwarder)
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
  `service.deploy` of `registry:2`, replicas 1, on the encrypted, attachable
  `swarmy` overlay, publishing no port. Every node's agent keeps a loopback
  forwarder (`swarmy-registry-forwarder`, a plain container on that overlay
  bound to `127.0.0.1:5000` and `:5001`), so the registry answers at
  `localhost:5000` on EVERY node and the Docker Hub pull-through cache at
  `localhost:5001`, and the hop to the registry's node rides IPsec. Docker
  trusts 127.0.0.0/8 registries as insecure by default, so every node's
  dockerd pulls plain-HTTP with zero daemon config. The forwarder is restarted
  by dockerd after a reboot and re-asserted by the agent, so pulls never
  depend on the controller. (The overlay name `swarmy-registry:5000` only
  resolves inside containers on the overlay — node dockerd can never pull it;
  it is still recognised as an org-registry prefix for legacy refs.) Images
  live in a standard OCI registry any tool can pull from — no lock-in.
- **Older clusters move by themselves (security review M16).** Before the
  forwarder, both ports were published on the swarm routing mesh, so the
  registry's login crossed the unencrypted `ingress` overlay between nodes.
  The controller moves a cluster onto the forwarders once every ready node's
  agent reports one, using the GC window's pinned spec so the registry stays
  on the node that holds its data, and never moves it back. Until then each
  agent's `SWARMY-REGISTRY` firewall chain keeps the mesh ports off public
  addresses; it stays afterwards as defence in depth. An installer re-run
  warns if the `swarmy` overlay was created without `--opt encrypted` or
  `--attachable`; Docker can't change either in place, so fixing it means
  recreating the overlay.
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
  service; a builder is any node carrying the `swarmy.node.builder` label (the
  legacy `swarmy.role=builder` still counts).
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
  become bindings. What didn't translate is listed per service with why
  (privileged, host networking, devices, host folders, the Docker socket,
  published ports, a database's data and credentials, and more). Literal
  credentials become `${{ secrets.<name> }}`, so no value lands in a file headed
  for git. An app already deployed from compose gets the same file from
  **Convert to swarmy.yaml** on its Source tab (`apps.convertToConfig`,
  read-only): swarmy can't write to git, so the next step is to commit the file
  and connect the repo.
- **A repo with no swarmy.yaml gets one drafted from its code.** Link & scan
  reads up to 40 source files under the app folder and greps them on the node
  (only matching lines come back). Detectors find Postgres, a Redis/Valkey cache
  or queue, S3 buckets, background workers, cron and the web port, each with the
  `file:line` that says so; the ticked ones become a swarmy.yaml where every
  connection is a binding (`gitConnections.draftConfig`), checked by the
  controller's parser and drawn as the app it creates. `swarmy check` and the
  MCP `check_repo` tool run the same detectors locally.
- **Git provider links can't be hijacked or widened.** Every OAuth/App flow
  (GitHub, GitLab, Gitea) sets a 10-minute host-only cookie
  (`__Host-swarmy-git-bind`) and signs its hash into the `state`, so the callback
  only completes in the browser that started it. A GitHub installation token is
  minted per job, for that one repo and only the permissions the job needs
  (contents:read to clone or build; checks/statuses/PR comments to report). A
  connection's credential is attached only to a clone URL on the connection's
  own host. Only the instance owner may register the controller-wide GitHub App;
  installing it stays open to every org's admins.
- **A replayed push can't roll an app back.** Deliveries are remembered in the
  controller store for 7 days, by the provider's delivery id and by the hash of
  the signed body, so a redelivery or a replay under a fresh id is acknowledged
  and dropped. Past that, the plan refuses a push of a commit that already ran in
  this environment and has since been replaced (`stale`, audited
  `app.plan.stale`), unless the push itself moved the branch off the live commit
  (a force-push back). New commits, `git revert`, dashboard deploys and retries
  are unaffected.
- **Environments come from swarmy.yaml or from a clone.** Releases ›
  Environments has **Clone as new environment**: a long-lived environment of a
  git app (its own stack `<app>-<name>`, from a branch, re-planned on pushes to
  it, never a preview and never swept). It lives in the dashboard until
  swarmy.yaml names it. Secrets are never copied: each becomes an empty slot,
  filled write-only into a Docker secret family of that environment's own
  (`<family>.<env>`) and mounted where the app already reads it. Its Postgres
  starts empty or as a copy of the source's newest backup, masked by
  `previews.data.scrub` when asked. It needs `stack.deploy` on the source stack
  and is audited `app.environment.clone`. The Variables tab shows **Shared
  variables**: each app-wide value per environment and where it comes from
  (service env › `environments.<name>.env` › shared `env:`), secrets masked. A
  cloned environment can't be removed from the dashboard yet.
- **Previews come from swarmy.yaml and tear themselves down.** A PR, an opted-in
  branch, or a trial deploy (`swarmy deploy --preview`) plans the branch's
  swarmy.yaml as its own preview environment (own stack, own URL under
  `previews.base_domain`, optionally a scrubbed data copy). Closing the PR or
  deleting the branch tears it down; `app-reconcile` removes anything past
  `previews.ttl`. While nobody opens it, a preview's services with an address
  sleep after `previews.sleep_after` (default 2 h; `never` keeps them up) —
  the same idle sleeper as any service, reading the edge's traffic — and the
  activator wakes them on the next request; `previews.size` caps how big any
  one preview service gets. An app's **Branch previews** page lists every
  preview with its address, data, time left and whether it is asleep, starts
  one from any branch with no pull request needed (`apps.createPreview`, any
  member, the plan's own gates still apply), and tears one down now
  (`apps.teardownPreview`, the `stack.remove` policy on the preview's stack,
  audited). Its rules are editable at Controls, and the file decides: when
  production's swarmy.yaml has a `previews:` block the page builds the block
  to paste (swarmy never writes to your repo); without one, saving keeps the
  rules on the production stack's services (`apps.setPreviewRules`, the
  `service.configure` policy, audited) until the file names `previews:`.
- **An AI agent can ship with a Deploy key.** The MCP server registers each
  tool for the scope its REST route needs: `deploy`, `trial_deploy` and
  `env_set` need `deploy` (the dashboard's Deploy preset), and
  `telemetry_toggle` and `remove_stack` need `write`. A Deploy key gives an
  agent the shipping tools without settings or removal. The controller still
  applies the person's role and the org's policies to every call. See
  `docs/CLI-AND-MCP.md`.

## Failure modes (designed, not accidental)

| Failure                                                           | Behaviour                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No builder node online                                            | `triggerBuild` fails fast (no `Build` row) with an actionable message: which builder is offline, or how to enable one (Builder role / `SWARMY_ALLOW_BUILD=true`). Never dispatched to a non-builder node.                                 |
| Railpack can't plan the repo                                      | `railpack prepare` exits 1 (transient exit 75 is retried): the build fails with Railpack's own reason and "add a Dockerfile, or set build.start".                                                                                         |
| Build cache missing or registry cache export fails                | Cold build (import is skipped with a log line); `ignore-error` on export means the build still succeeds.                                                                                                                                  |
| Build fails (bad Dockerfile, clone error)                         | Non-zero build exit → `commandResult` failed → `Build` row `FAILED`, full log retained in the live viewer; nothing is deployed.                                                                                                           |
| GC racing a running service                                       | The pinned set is computed from LIVE running digests each cycle, so a digest in use is never in the remove set; the agent ALSO refuses to delete a pinned digest (defence in depth) and `repoPrefix`-scopes to swarmy-pushed images only. |
| Registry node down                                                | Enable status shows `online:false`; builds can't push and fail cleanly. The registry is cache-rebuildable — you can always rebuild from git (S3 storage documented for anyone who needs HA).                                              |
| Webhook with a bad signature                                      | HMAC/token verification fails → `401`, no build. Pings and non-watched branches are acknowledged and ignored.                                                                                                                             |
| A signed push is replayed (redelivered, or captured and resent)   | A delivery id or body seen in the last 7 days is acknowledged and dropped; an older replay of a replaced commit is refused at the plan (`stale`). Nothing rolls back.                                                                     |
| An OAuth/App callback arrives from a browser that didn't start it | Refused: the bind cookie is missing or doesn't match the signed state, so nothing is linked to the org.                                                                                                                                   |
| Unsigned / critical-CVE image at deploy                           | Admission blocks with a plain-words reason and an audited override path; signing-not-verifiable fails closed rather than waving it through.                                                                                               |

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

- `admission-images.ts` (Trivy scan, cosign sign/verify, admission),
  `packages/trpc/src/services/apps.service.ts` (swarmy.yaml plans, incl. previews),
  `packages/trpc/src/routers/{cicd,registryPolicy,apps}.ts` (the tRPC surface),
  `apps/agent/src/handlers/{build,prune}.ts` +
  `packages/core/src/protocol/build.ts` (the agent capability),
  `apps/api/src/webhooks.ts` (the git webhook receiver; durable dedupe in
  `webhook-dedupe.ts`, the stale-push rule in
  `packages/trpc/src/services/apps/stale-commit.ts`), the git providers
  (`packages/trpc/src/services/git-providers/*`, Gitea in `git-gitea.service.ts`,
  the browser bind in `git-browser-bind.ts`), environments and conversion
  (`services/apps/{clone,env-secrets,env-layers,convert}.ts` over
  `packages/app-config/src/{clone-env,env-layers,from-compose}.ts`), the repo scan
  (`packages/app-config/src/scan/*`, `services/git-scan.ts`),
  `apps/api/src/workers/{image-gc,app-reconcile}.ts` (the background sweeps),
  `packages/db/prisma/schema/cicd.prisma` (the models),
  `apps/app/src/routes/_authed/ci.tsx` (the `/ci` workspace), the Branch previews
  page (`routes/_authed/stacks/$name.config.previews.tsx` →
  `components/gitops/previews/*`), and the MCP server's tool registry
  (`packages/devkit/src/mcp/server.ts`).
