# QA matrix, September 2026 (stage 1, local)

Stage 1 runs on this Mac with Lima VMs, a local registry, and local stand-ins for the outside world:

- Gitea as the git host
- Mailpit as the SMTP relay target
- sslip.io hostnames
- a locally built caddy-swarmy image
- a locally signed platform manifest

Stage 2 repeats the internet-facing rows on a real DigitalOcean cluster with a real domain.

**How each row is checked**

- **API**: tRPC `POST /api/trpc/<router>.<proc>` with body `{json}`, as used by the dashboard.
- **REST**: `/api/v1` with a `swk_` key, through the TypeScript SDK.
- **CLI**: `apps/cli`.
- **docker**: `docker service inspect`, `ps` or `exec` on a node.
- **browser**: Playwright headless Chromium.

**Where rows can run**

- **L**: local-testable.
- **L\***: local, but only with a workaround, noted in the row.
- **S2**: stage 2 only.

**Rig**

- `bash scripts/e2e-cluster.sh --prefix swarmy-qa --nodes 3 --cpus 2 --mem 4 --keep`
- Distinct `--registry-port`, `--file-port` and `SWARMY_E2E_WORKDIR`, so it never collides with the harness author's own cluster.
- Images come from HEAD. Scripts live in the QA scratchpad (`qa/*.ts`).
- Bugs are tracked in the scratchpad's `qa/BUGS.md`. The summary is at the end of this file.

## 1. Platform

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 1.1 | Install, `--mesh none` | Run the one-liner on node 1 with `--non-interactive --admin-email --image --agent-image --mesh none` | Exits 0. `swarmy_controller` 1/1, `/health` ok, the admin can sign in | docker, `/health`, sign-in | L |
| 1.2 | Install, `--mesh swarmy` | Same, with `--mesh swarmy` on a fresh VM | `swarmy-mesh-control` (netbird-server) runs before `swarm init`. `mesh.getConfig` reports driver netbird, managed-by-swarmy. The node is on wt0 | docker, API `mesh.getConfig`, `mesh.listPeers` | L |
| 1.3 | Add a server | `nodes.generateJoinToken`, then on the worker `curl <ctl>/install/loader.sh \| SWARMY_JOIN_TOKEN=… sh -s -- --controller …` | Node ONLINE in `nodes.list` and REST `/nodes`, swarm worker Ready | REST, docker `node ls` | L |
| 1.4 | NAT'd server over the mesh | With a mesh-swarmy install, block inbound on node 3 (iptables DROP except established), then join with `SWARMY_MESH_SETUP_KEY` + URL | Agent joins the mesh first, dials out, node ONLINE, swarm traffic over wt0 | API `mesh.listPeers`, docker | L\* (NAT simulated with iptables; real NAT from the Mac VM over the internet is S2) |
| 1.5 | Retire a server | `decommission.plan` → `start {confirmHostname, acceptWarnings}` → `status` | Tasks drained and moved, node removed from the swarm, stale copies listed | API, docker `node ls` | L |
| 1.6 | Move a volume | Stateful compose app on node 2 → `decommission.moveService {service, toNodeId}` | `swarmy.move.state` reaches done. Data checksum is the same on node 3; the old copy is listed in `oldCopies` | API, docker exec checksum | L |
| 1.7 | Disk forecast | `disk-usage` rule with a low threshold, or feed samples. Then `alerts.events` | A forecast event appears once there are ≥6 samples over ≥6 h | API `alerts.events` | L\* (needs about 6 h of samples; the threshold path is quick) |
| 1.8 | Cleanup (hygiene) | `nodes.hygiene {nodeId}` → `nodes.runHygiene {dryRun:true}` → real run | Report lists reclaimable space. The real run frees space and never removes an in-prod digest | API, docker `images` | L |
| 1.9 | Controller replication | `storage.enable` (Garage) → `controllerStore.enableReplication {kind:garage}` | Litestream running and `status` caught up; the controller restarts once | API `controllerStore.status`, docker | L |
| 1.10 | Controller move | `controllerStore.move {swarmNodeId}` to a second manager | Controller task on the new manager, data intact (stacks, users, keys) | API, docker `service ps` | L (needs 2 managers: promote node 2) |
| 1.11 | Platform upgrade | Install HEAD~N → sign a manifest locally (`scripts/platform-manifest.ts`) → `SWARMY_RELEASE_PUBKEY` → `platform.importRelease` → `platform.start` | Steps preflight → verify all ok; controller and agents on the new digest; apps untouched | API `platform.status`, docker | L |
| 1.12 | Swarm-stored settings | Set ingress, backup target, schedule, obs and rum settings → `docker service update --force swarmy_controller` (and delete control.db in a copy test) | Settings come back from the `swarmy-kv.*` configs; `docker config ls --filter label=swarmy.kv` shows them | API re-query, docker | L |
| 1.13 | Kill a worker → tasks reschedule | Existing harness step `reschedule` | Tasks move to another node; the node rejoins | harness | L |

## 2. Apps and deploys

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 2.1 | Templates (8, across categories) | `blueprints.list` → `blueprints.deploy {id, params:{name}}` for umami (analytics), ghost (cms), ntfy (comms), adminer (data), it-tools (devtools), uptime-kuma (monitoring), navidrome (media), vaultwarden (productivity), plus gitea | Each stack converges; its sslip.io URL answers 200/302; the `heavy` flag is accurate | API, curl URL, docker | L |
| 2.2 | Compose deploy | REST `POST /stacks {name, compose_source}` and tRPC `stacks.deployFromCompose`, then redeploy and remove | Deployment ref reaches succeeded; services running; remove cleans up | REST, docker | L |
| 2.3 | Image deploy | `services.create {name, image, ports, ingress}` → scale, restart, remove | Service running, URL answers, scale applied | REST, docker | L |
| 2.4 | Git app (Gitea) | Deploy the gitea template → push a repo with Dockerfile + swarmy.yaml → `gitConnections.create {kind:gitea, baseUrl, token}` → `linkRepo` → `apps.deploy` | Build runs on a builder node, image lands in the in-swarm registry, stack deployed, URL answers | API `cicd.listBuilds`, `apps.plans`, curl | L |
| 2.5 | Railpack build | Repo with no Dockerfile (Node app) | Build view shows the railpack `detected` field; image builds and runs | API, curl | L |
| 2.6 | Push → redeploy | Push a new commit | The `app-reconcile` poll picks it up and a new plan is applied | API `apps.plans` | L (a real GitHub webhook is S2) |
| 2.7 | Branch/PR previews | `previews.setSettings {enabled, baseDomain:sslip}` → `previews.createManual {repoId, branch}` → `destroy` | `pr…` / branch stack with its own URL; destroyed on request | API, curl | L |
| 2.8 | Previews with data | swarmy.yaml `previews.data.from: production` + scrub.sql, with a managed PG and a pg_dump backup in prod | The preview DB holds scrubbed prod rows; audit row `app.preview.data` | API, docker psql | L |
| 2.9 | Promote | Two environments (staging, production) → `apps.promote {repoId, from:'staging'}` | Production runs the staging digest with no rebuild | API, docker image digest | L |
| 2.10 | Canary/rollback | `releases.startCanary` / `promote` / `rollback` on a stack | Weights shift; rollback restores the previous spec | API, docker | L |
| 2.11 | Logs | REST `GET /services/{id}/logs`, the SSE stream, and tRPC `services.logs` | Recent lines returned; follow streams new lines | REST, CLI | L |

## 3. Edge and access

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 3.1 | Auto domains (sslip.io) | Deploy a service that publishes a port | `<svc>-<stack>.<ip-dashed>.sslip.io` stamped in `swarmy.ingress.auto.host`; answers over HTTP | curl, docker labels | L |
| 3.2 | Custom domain | `ingress.addDomain` with a host resolved through /etc/hosts or sslip | Caddy routes it; `domainStatus` reports sensibly | curl `--resolve` | L\* (real certs and DNS are S2) |
| 3.3 | Edge (Caddy) | `ingress.getConfig`, `ensureController`, `setTopology edge-per-node` | Caddy on the target nodes; routes render; `previewConfig` is valid | API, docker | L |
| 3.4 | App login | `appAccess.setRequireLogin {stack, on:true}` → a signed-out curl gets a 302 to `/app-login` → sign in → reach the app with `X-Swarmy-Jwt` | Unauthenticated users blocked; allowed people get through; the disallowed get a 403 | curl, browser | L |
| 3.5 | App users | App with `auth:` in swarmy.yaml → `appAccess.users` → `setUserDisabled` | A disabled user is refused | API, curl | L |
| 3.6 | Exposure modes | `exposure.overview`, `setMode private` on a service | A private service has no public route | API, curl | L |

## 4. Secrets

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 4.1 | Write-only | `services.setSecretVar {id, key, value, delivery:env}` → `services.secretVars` / REST `GET /services/{id}/env` | Value never returned; metadata only; service rolls | API, REST | L |
| 4.2 | Reveal | `services.revealSecretVar` as admin, then as member | Admin gets the value plus a `secrets.reveal` audit row; the member gets 403 | API, audit log | L |
| 4.3 | Rotate | `setSecretVar` with a new value, then `secretsMgr.create` / `rotate` / `attach` | New version rolled out; the container sees the new value; the old version is pruneable | docker exec env and /run/secrets | L |

## 5. Managed data

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 5.1 | Postgres create | `db.provision {stack, name, replicas:0}` → `db.inject` | Primary running; DATABASE_URL injected | docker psql | L |
| 5.2 | Postgres HA | `db.setTopology failover` + `setReplicas 1` | Replica streaming, `-dcs` etcd running, lag label present | docker `pg_is_in_recovery` | L |
| 5.3 | Failover | `resilience.runFailoverDrill {acknowledge:true}`, then kill the primary node | Replica promoted, labels flipped, the app reconnects; `db-failover` alert raised | docker, API | L |
| 5.4 | Backup | `backups.ensureNativeTarget` (Garage) and a node target → `dbBackups.backup pg_dump` | Snapshot listed | API | L |
| 5.5 | PITR | `dbBackups.setSchedule {pitr:true, targetId:s3}` → wal-g base backup → write rows at T1 and T2 → `restore {mode:pitr, targetTime:T1}` | Restored DB has the T1 rows and not the T2 rows | docker psql | L |
| 5.6 | Restore as copy | `db.provision` a copy → `restore {mode:clone-to-new-cluster}` | Copy matches the checksum; source untouched | harness step `postgres` | L |
| 5.7 | MySQL/Mongo/Redis dumps | Compose mysql:8, mongo:7, redis:7 → `backups.appDb.backupNow` → `restore {mode:copy}` then in-place | Copy DB or volume holds the rows | docker exec | L |
| 5.8 | Caches | `cache.provision valkey replica` → `attachToService` → `cache.stats` → `backup` / `restore` | REDIS_URL injected; stats returned; restore works | API, docker | L |
| 5.9 | Queues + queue studio | Deploy a bullmq worker (template `bullmq-worker`) → `queues.attach` → enqueue jobs → `queues.studio*`: retry, promote, pause, clean | Depths and job lists correct; actions apply | API, browser `/stacks/$name/queues/$cluster` | L |
| 5.10 | DB studio | `studio.targets` / `schema` / `browse` / `execute` (select; update with confirm) on PG, MySQL, Mongo and Redis | Rows returned; writes gated behind confirm; `studio.query` audit row | API, browser | L |
| 5.11 | Buckets + access modes | `storage.enable` → `buckets.createBucket` / `createKey` / `grantKeyOnBucket` → `presignUrl` PUT/GET → `setAccess` INTERNAL, MESH, PUBLIC | Presigned round-trip works; PUBLIC refuses without a public domain; access endpoints are right | API, curl | L (PUBLIC with a real domain is S2) |

## 6. Messaging, errors, telemetry, AI

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 6.1 | Email | Mailpit on the `swarmy` overlay → `email.setEnabled` → `addDomain {delivery:relay, relay:{host:mailpit, port:1025, security:none}}` → `checkDomain` → `testSend` | Message lands in the Mailpit API | Mailpit `/api/v1/messages` | L\* (domain verification needs the DKIM TXT through the controller resolver; real delivery is S2) |
| 6.2 | Transactional notify | `notifications.setConfig smtp → Mailpit` → `testSend` and REST `POST /notify` | Mail in Mailpit | Mailpit | L |
| 6.3 | Error tracking | `observability.setEnabled` → `errors.setEnabled {stack}` → redeploy a sample `@sentry/node` app → trigger an error | SENTRY_DSN injected; the issue appears in `errors.issues`; the issue page renders | API, browser | L |
| 6.4 | Analytics + replay | Build caddy-swarmy locally → `ingress.setControllerImage` → `rum.setSettings {enabled, replaySampleRate:1}` → Playwright visits the sample app (controller has `SWARMY_RUM_ALLOW_HEADLESS=1`) | `Swarmy-Rum` header present, snippet injected, `rum.analytics` counts, a replay exists and plays | curl, API, browser | L (behind real HTTPS is S2) |
| 6.5 | AI gateway (Ollama) | `blueprints.deploy ollama` → `ollama pull qwen2.5:0.5b` → `ai.providers` / `ai.models` → `ai.mintKey` → `POST /ai/v1/chat/completions` | Model discovered; the completion answers; usage logged | curl, API `ai.usage` | L (needs a 4 GB VM) |
| 6.6 | AI playground | `ai.playground {keyId, model, messages}` and the `/ai` page | Answer returned and rendered | API, browser | L |
| 6.7 | Alerts: ntfy | `blueprints.deploy ntfy` → `alerts.createChannel {ntfy}` → `testChannel` | Message in the ntfy topic (`/topic/json?poll=1`) | curl | L |
| 6.8 | Alerts: webhook | Channel `{webhook, url, secret}` pointing at a local echo service → test and a real `service-down` alert | POST received with a valid `X-Swarmy-Signature`; the event is in `alerts.events`; a critical event opens an incident | echo logs, API | L |
| 6.9 | Observability suite | `observability.setEnabled` → `enableForStack` → an OTel-instrumented sample → `traces` / `traceDetail` / `logs` / `metricsSeries` / `map` / `health` → status page `/status/<slug>.json` and `/s/<slug>` | ClickHouse and collector up; OTEL env injected; traces and logs present; the status page renders | API, docker, browser | L |

## 7. Developer surface

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 7.1 | CLI `check` | `swarmy check` on a sample repo | Local findings; exit code matches | CLI | L |
| 7.2 | CLI `deploy` / `logs` / `status` / `env` | `SWARMY_CONTROLLER` + `SWARMY_API_KEY` → `swarmy deploy`, `logs -f`, `status`, `env ls`, `env push --secret` | Works against the git app; secrets hidden | CLI | L |
| 7.3 | CLI login (device flow) | `swarmy login --no-browser` → approve at `/device` in the browser | Key stored mode 600, named `CLI · host` | CLI, browser | L |
| 7.4 | MCP stdio | `swarmy mcp` driven by an MCP client script: initialize, tools/list, call `list_apps`, `app_status`, `logs`, `env`, `check_repo`, `deploy`; `--read-only` hides the write tools | Tools listed and answering | script | L |
| 7.5 | MCP HTTP | `POST <ctl>/mcp` with a bearer key | Same tools | curl | L |

## 8. Governance and identity

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 8.1 | Member vs admin | `members.invite {role:member}` → accept as a new user → call admin procs | FORBIDDEN on admin procs; reads ok | API | L |
| 8.2 | Production gates | `guardrails.setStackEnv {production:true}` → the member deploys or restarts | Member denied in production, allowed outside it; an `operator` grant unlocks one stack | API | L |
| 8.3 | Who-can | `policies.whoCan {action:'stack.deploy', resourceType:'stack', resourceId}` | Lists admins plus the granted member | API, browser `/governance` | L |
| 8.4 | Invites | `members.invite` → `/login?invite=…` → sign up → `acceptInvite`; revoke and regenerate | Joined the org; a revoked link fails | API, browser | L |
| 8.5 | Username login | Install with a no-`@` admin, or create a username user → `signIn.username` | Signs in | API | L |
| 8.6 | SSO (OIDC) | Dex container reachable from the controller → `sso.upsert {oidc, issuer, clientId, secret, domain}` → browser login | User created and joined; SAML stored but not wired (documented gap) | browser | L\* (Dex on the VM) |
| 8.7 | API keys + audit | Mint and revoke keys; `auditLog` lists deploys, reveals and studio queries | Rows present | API | L |

## 9. Dashboard (browser pass)

| # | Feature | Steps | Expected | Verify | Where |
|---|---|---|---|---|---|
| 9.1 | Every route in `apps/app/src/routes` | Playwright visits all 63 route files with real params (a stack, service, node, build, incident, trace, error fingerprint, replay, queue cluster, status slug) | No console errors, no failed XHR (4xx/5xx other than expected), no blank or error boundary, no broken internal links | Playwright log + screenshots in `qa/shots/` | L |

## 10. Deferred to stage 2 (DigitalOcean + real domain)

- Real ACME certificates (HTTP-01), on-demand TLS, cert-expiry alerts.
- Custom domain + geo-DNS delegation (swarmy-dns as the authoritative NS).
- Wildcard DNS-01 through a DNS provider.
- Real GitHub App + webhooks (push and PR previews from GitHub).
- Real email delivery (port 25, DKIM/DMARC on a real zone, inbound).
- NAT'd server from the Mac VM over the internet via the mesh.
- Replay/RUM behind real HTTPS; PUBLIC buckets on a real domain; mesh-TLS letsencrypt.

## Results

The pass/fail table and bug summary are filled in as the run proceeds.
