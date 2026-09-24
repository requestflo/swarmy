# Epic: Git-connected apps — `swarmy.yaml`, and a push is the deploy

> Status: Phase 1 shipped (`packages/app-config`: schema, parser, validator,
> pure planner, golden tests). Phase 2 shipped (connections + auth, see the
> phase table). Phases 3–6 below are the build order.
> Owner's brief: "connect their Git repo (GitHub or GitLab or whatever), choose
> which repo, build the image from our own swarmy config. In it you can say: I
> want a database, I want a cache, all the native stuff. If they change it,
> swarmy reacts and does whatever it needs to fulfil the change."

## The feeling

Connect GitHub in one click (swarmy registers **your own** GitHub App, no
swarmy cloud involved). Pick a repo and a branch. swarmy finds `swarmy.yaml`,
shows the plan in plain words — _"create postgres 16 "db" · build
services/orders · deploy web · route orders.northwind.dev"_ — and one coral
**Deploy**. After that, the repo is the control panel: add `cache: cache` and
`REDIS_URL: ${{ cache.url }}`, push, and the cache exists and the app is wired
to it. Open a PR and it gets a check run, a sticky comment with the plan and
`pr-42.preview…`, and its own throwaway database. Delete the database from the
file and nothing is deleted — the dashboard says **"1 change needs you."**

## What exists today vs what is missing

| Area         | Exists (code)                                                                                                                                                                                       | Missing                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo link    | `GitRepo` (provider `GITHUB\|GITLAB`, url, branch, `tokenEnc` PAT, `webhookSecretEnc`, `autodeploy`, one `serviceId`, `previewsJson`) — `cicd.service.addRepo`                                      | Provider connections, OAuth/App auth, repo/branch picker, Gitea/Forgejo/generic git, deploy keys, monorepo config path, many apps per repo                                                                                                                                                               |
| Webhooks     | `POST /webhooks/git/:repoId`, HMAC (`X-Hub-Signature-256`) / GitLab token verified (`webhook-verify.ts`), push → build, PR → preview                                                                | App-level endpoint (one URL per GitHub App), delivery-id dedupe, changed-path filter (every push rebuilds everything), polling fallback for controllers GitHub can't reach                                                                                                                               |
| Build        | `image.build` agent command; rootless BuildKit on Builder nodes; digest-pinned push to in-swarm `registry:2`; Trivy + cosign; live logs                                                             | Builds by **branch** (`git clone --branch`, a race vs the webhook's SHA); `runBuild` never passes `subdir`/`dockerfile`/`buildArgs`/`target` though the protocol has them; no build cache (fresh buildkitd, no `--export-cache`); no zero-config builds; no build secrets; no pre-deploy release command |
| Deploy       | `deployFromCompose` (stack naming, admission spine, `Release` rows, health gate + auto-rollback, canary)                                                                                            | A declarative app model; a diff/plan; destructive-change gating; drift detection                                                                                                                                                                                                                         |
| Managed data | `provisionDb`/`injectConnection`, `provisionCache`/`attachCacheToService`, `provisionSearch`, `provisionVector`/`enablePgvector`, `createBucket`/`attachToService` — label-truth, reconcile workers | Declaring them from a file; binding syntax; applied-signature labels                                                                                                                                                                                                                                     |
| Edge         | `swarmy.ingress.routes` with `RouteProtection` (rate limit, IP/country allow/deny, bots, WAF-lite, cache); scale-to-zero labels; custom domains (in flight, other agent)                            | Routes/protections from config                                                                                                                                                                                                                                                                           |
| Jobs         | `ScheduledJob` (cron, `serviceRef` or image, retries, timeout)                                                                                                                                      | Jobs from config                                                                                                                                                                                                                                                                                         |
| Previews     | `pr<N>-<repo-short>` from the linked stack's compose, TTL, label truth                                                                                                                              | Isolated per-PR resources, PR comment/check, fork protection, preview password                                                                                                                                                                                                                           |
| Feedback     | none                                                                                                                                                                                                | Commit status / check run, sticky PR comment                                                                                                                                                                                                                                                             |
| Cross-app    | stack links landing (`connectStacks`, `swarmy.links`, networking agent)                                                                                                                             | `connect:` in config                                                                                                                                                                                                                                                                                     |

## Decisions

1. **One config file, `swarmy.yaml` v1, compiled — not a lock-in format.** It is
   a thin intent layer that compiles to plain compose + `swarmy.*` labels + managed
   resource declarations (which are themselves ordinary swarm services). **Export
   compose** on a git app emits vanilla compose including the resources' real
   services. This keeps the "no swarmy-only manifest" rejection in
   `deploy-and-releases.md` honest: the canonical model is still compose/
   `ServiceModel`; swarmy.yaml is an authoring front door. (Update that doc's
   rejection line in Phase 3.)
2. **Git is the source of truth for everything the file declares.** Docker
   remains the source of truth for _what runs_; swarmy stamps each applied unit
   with `swarmy.app.sig` so the planner diffs cheaply.
3. **Destructive changes never auto-apply.** A plan is gated per action: `auto`,
   `confirm` (held for a human in the dashboard, rest of the plan proceeds), or
   `blocked` (impossible — e.g. postgres downgrade — nothing applies, check fails).
4. **The planner is pure and shared.** `@swarmy/app-config` runs identically in
   the controller (apply), the PR check (plan comment), and the dashboard editor
   (live validation + preview) — same errors, same line numbers.
5. **Binding syntax is `${{ <thing>.<field> }}`** — never collides with compose's
   `${VAR}`, which passes through verbatim. `$${{` escapes.
6. **GitHub = a per-instance GitHub App via the manifest flow**; GitLab = OAuth
   application (self-managed base URL) with project-token fallback; everything
   else = generic git over HTTPS PAT or a swarmy-generated SSH deploy key.
   Installation tokens are minted just-in-time and never stored.
7. **Reading the commit runs on a Builder** (`git.inspect`): one path for every
   git host, the controller never clones. It is a pure program + parser
   (`git-providers/inspect.ts`) dispatched over the existing `container.runOnce`
   in the builder image — no new protocol message was needed (partial depth-1
   fetch at the exact sha; files capped at 32 KB to fit runOnce's 64 KB output
   tail). Provider APIs are used only to write feedback (checks, statuses,
   comments) and to list repos/branches.
8. **Zero-config builds = Railpack**, behind Dockerfile: Dockerfile present →
   BuildKit dockerfile frontend (today); absent → Railpack (BuildKit LLB, fits the
   rootless `buildctl` path); `static:` publish-dir mode. No Nixpacks (maintenance
   mode, superseded by Railpack), no herokuish/CNB.
9. **Build cache lives in the in-swarm registry** (`type=registry`,
   `mode=max`, ref `<registry>/<app>/cache:<buildKey>`) so any Builder node gets
   a warm cache; builder affinity is a preference, not a requirement.
10. **Previews get isolated throwaway resources by default** (single postgres, no
    backups, internal buckets, no cron, no cross-app links); `resources: shared`
    is an explicit, warned opt-in. Fork PRs never build without a maintainer's
    approval.

## Provider connections & auth

### Models (Phase 2, `packages/db/prisma/schema/cicd.prisma`)

- **`GitConnection`** — `{ id, orgId, kind: GITHUB_APP | GITLAB | GITEA | GENERIC,
baseUrl, displayName, appId?, appSlug?, clientId?, clientSecretEnc?,
privateKeyEnc?, webhookSecretEnc, oauthRefreshTokenEnc?, createdBy }`. All
  secrets via `@swarmy/core/crypto` (`SWARMY_SECRET_KEY`), never returned.
- **`GitInstallation`** — `{ id, connectionId, orgId, externalId, account,
repoSelection }` (GitHub App installations bound to _this_ org).
- **`GitRepo` evolves into the app binding** (pre-launch, no back-compat):
  `+ connectionId, externalRepoId, configPath (default "swarmy.yaml"), appName,
lastAppliedSha, deployKeyEnc?`; `tokenEnc` removed; `serviceId/autodeploy`
  kept only for build-only repos (`mode: APP | BUILD_ONLY`). Unique on
  `(orgId, externalRepoId, branch, configPath)` — a monorepo holds many apps.
- **`AppPlan`** — history: `{ id, orgId, repoId, sha, trigger (push|pr|manual|
drift), planJson, status (planned|applying|applied|partial|needs-confirmation|
blocked|failed|superseded), confirmedBy?, confirmedAt?, error? }`. Pending
  confirmations are the `confirm` actions of the latest plan; nothing about what
  _runs_ is stored here (Docker labels own that — `docker-native-storage`).

### GitHub App via the manifest flow

1. Admin clicks **Connect GitHub**. The dashboard POSTs a manifest to
   `https://github.com/settings/apps/new` (or `/organizations/<org>/settings/apps/new`)
   with a signed `state` (orgId, userId, nonce, 10-min expiry):
   `name: swarmy-<host>`, `hook_attributes.url: https://<controller>/webhooks/github/<connectionId>`,
   `redirect_url: …/git/github/manifest/callback`, `setup_url: …/git/github/setup`,
   `public: false`, permissions `contents:read, metadata:read, checks:write,
statuses:write, pull_requests:write`, events `push, pull_request,
installation, installation_repositories`.
2. Callback exchanges `code` via `POST /app-manifests/{code}/conversions` →
   `id, slug, pem, webhook_secret, client_id, client_secret` → vault.
3. User installs the app on chosen repos → `setup_url?installation_id=…`. To stop
   org A claiming org B's installation (hosted tier), the setup callback runs the
   app's user-to-server OAuth and checks `GET /user/installations` contains it
   before binding it to the org.
4. At dispatch: JWT (RS256, the pem) → `POST /app/installations/{id}/access_tokens`
   → 1-hour token used as `x-access-token` for clone and API. Never persisted.

One app per controller instance; installations are bound per org. A controller
GitHub cannot reach (no public URL) gets **polling**: an `app-poll` worker lists
branch heads via the API every 60 s (outbound only).

### GitLab, Gitea/Forgejo, generic

- **GitLab**: admin registers an OAuth application once (client id/secret +
  base URL for self-managed); users authorize; refresh token in vault. swarmy
  auto-creates the project webhook with a random secret token. Fallback: a
  project/group access token (`api` scope) pasted once.
- **Gitea/Forgejo** (Phase 4): same OAuth2 shape as GitLab; HMAC webhooks.
  Bitbucket after.
- **Generic git**: HTTPS + PAT, or **deploy key** — swarmy generates ed25519,
  shows the public key once, keeps the private key encrypted; `GitBuildSource`
  grows an optional `sshKey` (protocol only grows). Webhook with
  `X-Swarmy-Signature: sha256=…` HMAC, or polling via `git ls-remote` on the
  builder.

### Webhooks

- `POST /webhooks/github/:connectionId` — verify HMAC with the connection
  secret _before_ parsing; dedupe on `X-GitHub-Delivery` (5-min LRU + AppPlan
  unique `(repoId, sha, trigger)`); route by `repository.id` → every `GitRepo`
  app on that repo+branch.
- `POST /webhooks/git/:repoId` stays for GitLab/generic.
- Pings and unwatched branches: 200 + ignored (as today).

### Scoping + ABAC

Everything keyed by `orgId`; the repo picker lists only repos reachable through
the org's own installations/tokens. Actions (with the owner-decisions agent):
`git.connect` (admin), `apps.create` / `apps.update` / `apps.deploy`,
`cicd.remove` for removing a connection or an app binding. A destructive plan
step is authorized by **what it destroys**, via `evaluateAccess(ctx, action,
resource)` (same decision path as `abacProcedure`): `data.destroy` for
resource/volume deletes, `service.remove` / `stack.remove` for workloads.
Every confirm is audited (`writeAudit`, actor = the confirming user; the
automatic part of a push is `actorType: system`). Resource type `gitApp`
carries `repo`, `branch`, `app` attributes so a ReBAC grant can give a team
deploy rights on one app.

## `swarmy.yaml` v1

Minimal — a Postgres-backed web app:

```yaml
version: 1
app: blog
services:
  web:
    build: .
    port: 3000
    domains: [blog.example.com]
    env:
      DATABASE_URL: ${{ db.url }}
resources:
  db: postgres
```

Full, annotated (this is `FULL_EXAMPLE` in `packages/app-config/src/examples.ts`,
parsed clean by the tests):

```yaml
# yaml-language-server: $schema=https://swarmy.dev/schema/swarmy.v1.json
version: 1
app: orders                  # stack name; services become orders_web, …
env: { NODE_ENV: production } # shared by every service (service env wins)

services:
  web:
    build:                   # or `image: ghcr.io/x/y:1.2` — exactly one of build|image
      path: services/orders  # monorepo subpath = build context
      dockerfile: Dockerfile # relative to path; absent file → Railpack (Phase 4)
      args: { APP_VERSION: "2" }
      watch: [services/orders, packages/shared]  # rebuild only if these change
    release: npm run migrate # one-shot in the NEW image before rollout; failure aborts
    port: 3000
    replicas: 2
    size: small              # nano|small|medium|large|xlarge, or cpu:/memory:
    healthcheck: { path: /healthz, interval: 10s }
    env:
      DATABASE_URL: ${{ db.url }}
      DATABASE_RO_URL: ${{ db.ro_url }}
      REDIS_URL: ${{ cache.url }}
      S3_ENDPOINT: ${{ invoices.endpoint }}
      S3_BUCKET: ${{ invoices.bucket }}
      SEARCH_URL: ${{ search.url }}
      PUBLIC_URL: ${{ app.url }}       # preview-aware
    secrets: [stripe-key]    # swarmy secret → /run/secrets/stripe-key
    domains:
      - orders.northwind.dev
      - host: api.northwind.dev
        path: /v1
        protect: { rate_limit: 100/min, countries_deny: [RU], block_bots: true }
    regions: [eu-west]       # placement on swarmy.region

  worker:                    # no port = a background worker
    build: { path: services/orders, dockerfile: Dockerfile, args: { APP_VERSION: "2" },
             watch: [services/orders, packages/shared] }   # same inputs → ONE build
    command: [node, dist/worker.js]
    env: { DATABASE_URL: ${{ db.url }}, REDIS_URL: ${{ cache.url }} }

  admin:
    image: ghcr.io/northwind/admin:1.4.2
    port: 8080
    sleep_after: 15m         # scale-to-zero; next request wakes it
    env: { ORDERS_API: ${{ services.web.url }} }   # → http://web:3000
    domains: [admin.northwind.dev]
    volumes: { uploads: /data/uploads }            # persistent named volume

resources:
  db:
    type: postgres
    version: 16              # 14–17
    ha: primary-replica      # single|primary-replica|failover|geo|active-active
    replicas: 1
    backups: { schedule: daily, keep: 14 }   # default daily/7; `false` = off
  cache: { type: cache, engine: valkey, memory: 512mb }  # ha: single|replica|sentinel
  search: { type: search, engine: meilisearch }          # or typesense
  embeddings: { type: vector, engine: pgvector, on: db } # or engine: qdrant
  invoices: { type: bucket, access: internal }           # internal|mesh|public

jobs:
  invoices: { schedule: "0 2 * * *", service: worker, run: npm run invoices, timeout: 30m }

previews: { enabled: true, ttl: 48h }   # resources: isolated (default) | shared
connect: [billing]                      # private overlay to another app in this org
```

### Binding fields

| Namespace         | Fields                                                                |
| ----------------- | --------------------------------------------------------------------- |
| postgres          | `url ro_url host ro_host port database user password`                 |
| cache             | `url host port password password_file`                                |
| search            | `url host port key_file`                                              |
| vector            | `url host port` (pgvector: the postgres url)                          |
| bucket            | `endpoint bucket region access_key_id secret_access_key_file`         |
| `services.<name>` | `url host port` → short alias on `<app>_default` (`http://web:3000`)  |
| `app`             | `name url domain` (preview-aware)                                     |
| `secrets.<name>`  | the value — **warns**: it lands in the service env; prefer `secrets:` |

Reserved names: `app apps services secrets preview` (`apps.<app>.<svc>.url` →
`http://<svc>.<app>:<port>` for connected apps is reserved for v1.1). Resolution
happens at apply, controller-side, through the same inject paths the Data tab
uses (env + secret file + private overlay attach), then `renderValue`.

### Defaults worth knowing

`replicas: 1`; postgres 16 `primary-replica` + 1 replica + daily backups kept 7;
cache valkey single 256 MB; search meilisearch; vector qdrant unless `on:`;
bucket internal; job timeout 10 m; preview TTL 72 h; preview services sleep
after 30 m idle. `swarmy.yaml` itself never triggers a rebuild.

### Validation (all located by line/col)

YAML syntax, duplicate keys (error, not last-wins), 256 KB cap, unknown keys
("unknown key "replica""), exactly-one-of build|image, reserved names,
service/resource collisions, bindings resolve to a declared thing and a field
it exposes, `services.x.url` needs a port, HTTP healthcheck and domains need a
port, duplicate host+path, `ha: geo` needs `regions`, sentinel needs a replica,
pgvector's `on:` is a postgres, jobs name a service (defaults to the single
built service). Warnings: floating image tag, public bucket, sleep without a
domain, secret-in-env, shared preview resources.

### Editor autocomplete

`SWARMY_YAML_JSON_SCHEMA` (hand-written draft 2020-12, with tooltips; a test
guards key parity with Zod). The controller serves it at
`/schema/swarmy.v1.json` (Phase 5); submit to SchemaStore for `swarmy.yaml`.

### Relation to `docker-compose.yml`

- A repo with **only** compose: _compose mode_ — services with `build:` are
  built (context/dockerfile from compose), images swapped for digests, deployed
  via `deployFromCompose`. No native resources.
- The dashboard offers **"Convert to swarmy.yaml"** (Phase 5,
  `composeToAppConfig`): recognisable postgres/redis/meili/qdrant/minio services
  become `resources:` with bindings replacing their connection strings.
- A repo with both: `swarmy.yaml` wins; compose is ignored with a warning. v1
  has no `include:` of compose (one source of truth).
- Export: a git app exports to vanilla compose (resources as their real services).

## The GitOps loop

```
push / PR event ─▶ verify HMAC ─▶ dedupe ─▶ per matching app (repo+branch+configPath):
  ① git.inspect @ exact SHA on a Builder (sparse fetch): swarmy.yaml text +
     changed paths since lastAppliedSha (PR: since merge-base)
  ② parseAppConfig → issues? → check run FAILURE with located annotations; stop
  ③ toDesired (preview-retargeted for PRs) ; read LiveApp from hub labels
  ④ planApp(desired, live, { changedPaths }) ; persist AppPlan
  ⑤ admission: every service.deploy spec through evaluateAdmission
     (guardrails · exposure · images); block → plan blocked (reason in the check)
  ⑥ check run + sticky PR comment = planToMarkdown(plan, { previewUrl })
  ⑦ apply `auto` actions in phase order (PRs: preview stack only; main: prod):
     1 resources (provision*/update through existing services; stamp sig)
     2 builds (exact SHA, registry cache) — parallel per build key
     3 release command → service.deploy by digest (Release row, health gate)
     4 routes, jobs, links   5 removals   6 (confirm only) resource deletes
  ⑧ `confirm` actions wait in the dashboard ("1 change needs you") — confirm
     = evaluateAccess per destroyed thing + audit, then execute
  ⑨ lastAppliedSha = SHA when every non-held action succeeded; check SUCCESS
```

- **Concurrency**: one apply per app; a newer SHA on the same branch supersedes
  queued work (queued builds cancelled, AppPlan `superseded`). Apply is
  resumable: each action is idempotent and the executor resumes from the first
  un-stamped unit after a controller restart.
- **Partial failure**: a failed build or deploy stops later phases that depend
  on it; resources already created stay (forward-only); the check run says
  exactly which action failed with the log tail (`buildFailureError`).
- **Drift policy**: fields the file declares are git-owned. In the dashboard
  they are locked: _"Managed by swarmy.yaml — edit in git"_ with **Open PR**
  (Phase 5: swarmy commits the edit to a branch via the provider API and opens a
  PR). Admins get an audited **Override until next push** (label
  `swarmy.gitops.override=<unit>` + badge _"Overridden — the next push
  reverts"_). The `app-reconcile` worker (5-min tick, `reconcile-workers`
  pattern) recomputes the plan against live; a non-empty plan with no new commit
  is **drift**: surfaced, never silently reverted, one-click _"Re-apply
  <sha>"_. Runtime knobs the file does not own (current scale-to-zero replica
  count, canary weights, manual scale when `replicas` is absent) are not drift.
- **Rollback**: preferred = `git revert` (it's GitOps). Dashboard rollback
  redeploys the previous applied SHA's _services_ by their recorded digests
  (`Release` rows) and pins the app (override) until the next push. Resources
  never roll back — data is forward-only; the rollback dialog says so.
  Auto-rollback on a failed health gate is the existing `deploy-safety` worker.
- **Secrets**: a referenced secret that doesn't exist blocks the plan with
  _"create secret stripe-key"_ (LiveApp gains `secrets: string[]` in Phase 3).

## Build

- **Exact SHA**: `GitBuildSource` gains optional `sha`; the program does
  `git init && git fetch --depth 1 origin <sha> && git checkout FETCH_HEAD`
  (branch clone stays the fallback). `runBuild` passes `subdir`, `dockerfile`,
  `target`, `buildArgs` it already has in the protocol. Image refs:
  `<registry>/<app>-<buildKey8>:<sha12>`; deploy by digest as today.
- **Cache**: `--export-cache type=registry,ref=<registry>/<app>/cache:<buildKey>,mode=max
--import-cache type=registry,ref=…` — node-independent, rides the existing
  registry (never node-GC'd). Keep `SOURCE_COMMIT` out of layers (env at
  runtime, not a build arg) so cache survives commits.
- **Zero-config**: `image.build` gains an additive `builder: dockerfile |
railpack | static`. Auto-pick: Dockerfile present → dockerfile; else Railpack
  (`railpack prepare` → plan → `buildctl --frontend gateway.v0 --opt
source=ghcr.io/railwayapp/railpack-frontend`); `static: dist` → Caddy file
  server image. Pinned frontend images (bootstrap gotcha as for BuildKit).
- **Build secrets**: `build.secrets: [npm-token]` → `--secret id=…,env=…`, never
  layered (Phase 4, schema v1.1).
- **Which node**: existing `pickBuilderNode`; prefer the node that last built
  this build key (warm local layers), else any online Builder; one build per
  Builder at a time, FIFO per org. Multi-arch: build for the builder's arch;
  admission warns if the service's placement can land on a different arch.
- **Logs**: unchanged `logChunk` → `build-log-bus`; the check run links
  `/ci/builds/<id>`.
- **Third-party registries**: org registry credentials for GHCR/Docker Hub
  pulls of `image:` services (extend `registry-auth.ts`, per-org
  `RegistryCredential` rows) — Phase 4.

## Previews

`toDesired(cfg, { preview: { pr, baseDomain } })` (shipped): stack
`<app>-pr<N>`, ≤1 replica sleeping after 30 m, single postgres without backups,
internal buckets, no jobs, no links, hosts `pr-<N>.<base>` (first routed
service) and `pr-<N>-<svc>.<base>`. Closed/merged PR or TTL → teardown incl. its
resources (`data.destroy` evaluated as SYSTEM — preview data is declared
disposable). **Fork protection**: PRs from forks never build until a maintainer
comments `/swarmy preview` or applies a label; public repos default off.
Later: preview DB **forked from the latest backup** (reuse the restore-drill
clone) and preview **password protection** (Caddy `basic_auth`), both
`previews:` keys in v1.1.

## UX outline (Hot Signal voice; with the designer)

1. **Stacks → New app → From Git**: _Connect GitHub_ (one click → GitHub → back
   "Connected."), GitLab, or "Any git URL". Repo search, branch picker.
2. **Detect**: `swarmy.yaml` found (per path — monorepos list every
   `**/swarmy.yaml`), or compose found (_compose mode_ / _Convert_), or
   Dockerfile only / nothing → a starter `swarmy.yaml` from `MINIMAL_EXAMPLE`
   they can commit via a PR.
3. **Plan** screen: the action list with gate icons, _Deploy_ (one coral CTA).
4. Stack workspace: a **Source** chip `github.com/northwind/orders@main ·
a1b2c3d`; Releases show the commit per release; a **Plan** drawer with
   "1 change needs you" + Confirm; drift + override badges; locked fields.
5. `/ci` keeps builds, registry, GC; repos list becomes connections + apps.

## Phases

| #    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Size | Modules                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ✅ | Pure `@swarmy/app-config`: schema, parser (located issues), validator, `toDesired` (+ preview), `planApp` (gated, ordered), `planToMarkdown`, JSON Schema, examples, 46 golden tests                                                                                                                                                                                                                                                                                                                                                                                                            | S    | `packages/app-config/src/*`                                                                                                                                                                                                                                                                                                                 |
| 2 ✅ | Connections & auth: GitHub App manifest flow (one App per controller), installations bound to orgs only after the installing user's OAuth sees them, GitLab OAuth + token, Gitea/generic PAT, SSH deploy keys; repo/branch picker; `linkRepo` (monorepo `configPath`, GitLab hook auto-created); App webhook + delivery dedupe + fork protection; Gitea/generic signatures; `git.inspect`; exact-sha builds with subdir/dockerfile/target/args; `swarmy / build` check run / status; sticky preview comment. **Not yet:** polling worker for unreachable controllers, REST routes, dashboard UI | L    | `schema/cicd.prisma` (+ migration 0015); `services/git-providers/{types,state,github-app,gitlab,generic,inspect}.ts`; `services/git-{connections.service,credentials,feedback.service}.ts`; `routers/gitConnections.ts`; `apps/api/src/{webhooks,webhook-verify,git-callback}.ts`; `protocol/build.ts` + `apps/agent/src/handlers/build.ts` |
| 3    | The GitOps apply loop: LiveApp reader, executor over existing services, `AppPlan`, confirm mutation, check runs + sticky PR comment, preview-with-resources, drift worker, override label                                                                                                                                                                                                                                                                                                                                                                                                       | L    | `services/apps.service.ts`, `services/app-live.ts` (pure label → LiveApp), `services/app-apply.service.ts`, `services/git-feedback.service.ts`, `routers/apps.ts`, `workers/app-reconcile.ts`, `previews.service.ts` (delegate to toDesired), REST `routes/apps.ts`                                                                         |
| 4    | Builds++: exact SHA, subdir/dockerfile/args plumbed, registry cache, Railpack + static, release command, build secrets, builder affinity/queue, third-party registry creds, Gitea/Forgejo                                                                                                                                                                                                                                                                                                                                                                                                       | M    | `protocol/build.ts`, `apps/agent/src/handlers/build.ts`, `cicd.service.ts`, `registry-auth.ts`                                                                                                                                                                                                                                              |
| 5    | UX: New app from Git wizard, Plan drawer, locked fields + Open PR, Source chip, served JSON Schema, Convert compose → swarmy.yaml, compose mode                                                                                                                                                                                                                                                                                                                                                                                                                                                 | M    | `apps/app` routes/components (designer + app owner), `app-config/src/from-compose.ts`                                                                                                                                                                                                                                                       |
| 6    | Environments (`staging` branch → second stack), `apps.<app>` bindings, preview DB fork + basic auth, Terraform/SDK parity                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M    | app-config v1.1, api-rest, sdks                                                                                                                                                                                                                                                                                                             |

## Risks

- **Fork PRs = arbitrary code on your builder.** Mitigated by approval gating,
  rootless BuildKit, Builder-role isolation; never expose org secrets to PR
  builds (build secrets disabled for fork PRs).
- **Controller not reachable by GitHub** (homelab behind NAT): polling fallback;
  the tunnel ingress can also front the webhook route.
- **Destructive bypass via rename** (`db` → `database`): a rename is a delete +
  create, and deletes are always `confirm` — covered by the planner tests.
- **Adopting existing resources**: a live unit without `swarmy.app.sig` is
  `confirm` ("review before swarmy takes it over"), never silently mutated.
- **Label bloat**: the last-applied unit JSON label (`swarmy.app.applied`) is
  capped at 8 KB; above it only the sig is stamped (field-level diffs degrade to
  "changed").
- **Apply half-done on controller crash**: idempotent actions + resume from
  labels; AppPlan status `applying` older than 30 min is re-planned.
- **Provider rate limits**: installation tokens cached ≤ 55 min in memory; one
  sticky comment edited, not re-posted.
- **Preview cost**: per-app max concurrent previews (default 5) + TTL + sleep.
- **Schema evolution**: `version: 1` is required; v2 ships a pure `migrateV1`
  and the check run suggests the upgraded file.

## Open questions for the owner

1. Default postgres HA for a git app: `primary-replica` (current product default,
   2 containers) or `single` (cheaper hobby default)? Planner currently uses
   `primary-replica`.
2. Should a push to the prod branch apply immediately, or should prod require
   a dashboard "Promote" (plan-then-apply) per app? Proposed: immediate, with a
   per-app `require approval` toggle.
3. One GitHub App per controller instance with org-bound installations (proposed),
   or one app per swarmy org?
4. Environments beyond prod + PR previews (a `staging` branch) — v1 or v1.1?
5. Is `${{ secrets.x }}` in env acceptable (with a warning), or should v1 only
   allow file mounts?
