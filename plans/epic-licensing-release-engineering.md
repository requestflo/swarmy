# Epic: Licensing model + semantic-release + CI/CD versioning

> Status: plan / implementation-ready. This epic is unusual: the scaffold **already ships a first pass** — `LICENSE.md` is FSL-1.1-Apache-2.0, `.releaserc.json` runs single-version semantic-release, `commitlint.config.mjs` enforces Conventional Commits with workspace scopes, and `.github/workflows/{ci,release}.yml` exist. The job here is **not greenfield**: it is to (a) ratify the license choice and operationalize it across the monorepo (headers, open-core split, NOTICE, CLA), and (b) harden the release pipeline from "computes a version + GitHub release" to "ships agent + controller container images, an install script, and signed, reproducible releases." Do not redesign the scaffold; close the gaps in it.

## Problem

Two coupled problems, both load-bearing for the business model.

**1. License.** swarmy is "source-available, commercial use allowed, enterprise features + a hosted cloud by the swarmy team; others may NOT sell it as a service without approval, ideally converts to true OSS over time." That sentence is a license spec. The wrong choice either (a) scares off the self-host users we want (too restrictive / scary / non-standard), or (b) lets a hyperscaler or a competitor wrap swarmy as "Managed swarmy" and eat the hosted-cloud revenue that funds the project. The scaffold picked FSL-1.1-Apache-2.0; this doc must *justify* that against the real alternatives (BSL 1.1, Elastic License 2.0, SSPL, generic "Fair Source"), then make it real across a monorepo with shared packages and a future enterprise/open-core split — not just one `LICENSE.md` at the root.

**2. Release engineering.** A controller + per-node agent that people deploy with one command needs an absolutely boring, automated release train: every merge to `main` must produce a correct version, a changelog, a GitHub release, **published agent and controller container images**, and a **working `curl | sh` install script** pinned to that version. The current pipeline computes a version and cuts a GitHub release but **publishes no images, no install script, runs no tests/lint, and has no DB for integration tests**. The agent's whole NAT-friendly dial-out story is worthless if there's no published `swarmy/agent:1.4.0` image to `docker run`. This epic builds that train and decides the monorepo versioning policy (single-version vs per-package — they are NOT equivalent here).

## Recommended approach

### License: **ratify FSL-1.1-Apache-2.0** (lean confirmed). Add an open-core seam under Elastic-License-2.0-style terms *only if/when* a closed enterprise module ships.

The requirement maps almost 1:1 onto FSL, which is why the scaffold's pick is right. Walking the spec against the candidates:

| Requirement | FSL-1.1-Apache-2.0 | BSL 1.1 | Elastic v2 | SSPL | "Fair Source" (umbrella) |
|---|---|---|---|---|---|
| Commercial self-host / client work allowed | ✅ explicit Permitted Purpose | ✅ (you set the Additional Use Grant) | ✅ | ✅ but viral | depends on member license |
| Block "sell it as a competing managed service" | ✅ Competing Use clause, tight + specific | ✅ but **you must hand-write** the grant; easy to get wrong | ✅ (no "provide to third parties as managed service") | ✅ (via the §13 source-disclosure bomb) | depends |
| Converts to true OSS over time | ✅ **2 yr → Apache-2.0, per version, automatic** | ✅ but **you pick the date + the Change License**; default is 4 yr | ❌ never converts | ❌ never converts | only FSL/some members convert |
| Short, standard, recognizable, low legal-FUD | ✅ ~1 page, fixed text, SPDX-listed, growing adoption (Sentry, Codecov, Sourcegraph-adjacent, Liquibase, PowerSync) | ⚠️ parameterized → every BSL repo is subtly different; reviewers must read it | ✅ short, but "Elastic" branding + never-OSS | ❌ feared/banned by many orgs (OSI-rejected, "the AWS license") | ⚠️ it's a *movement*, not a license |
| Fits an open-core split later | ✅ core under FSL, enterprise under a stricter license | ✅ | ✅ | ⚠️ heavy | n/a |

**Why FSL wins for swarmy specifically:**

- **It is BSL with the foot-guns removed.** BSL 1.1 is a *template*: you must author the "Additional Use Grant" and choose a "Change Date" and "Change License." Most BSL controversy (MariaDB, then HashiCorp's BSL-via-template-confusion) comes from people getting that wording wrong or picking 4 years. FSL is a *fixed* instantiation of the same idea — one specific grant, a hard 2-year clock, conversion to Apache-2.0 — so it's reviewable at a glance and there's nothing for us to mis-draft.
- **The 2-year → Apache-2.0 conversion is the trust anchor.** It directly satisfies "ideally converts to true OSS over time," and it's the single best answer to the "is this a rug-pull?" objection: every version we ship today is genuinely Apache-2.0 in 24 months, irrevocably, even if swarmy the company disappears. That is a much stronger community promise than Elastic v2 (never converts) or SSPL (never converts).
- **The Competing Use clause is purpose-built for our exact threat model.** It blocks "making the Software available to others in a commercial product or service that substitutes for the Software or for any product/service we offer (e.g. swarmy Cloud)" — i.e. it blocks "Managed swarmy" while *explicitly* allowing internal use, client/consulting work ("professional services... to a licensee"), education, and research. That is precisely "use it for anything except reselling it as a competing service."
- **Adoption + SPDX recognition** lower legal-review friction for the enterprises we eventually sell to. It's no longer exotic in 2026.

**Rejected:**
- **SSPL** — overbroad ("offer as a service → release your *entire* service stack"), OSI-rejected, and actively blocklisted by some corporate legal/procurement. It would scare off exactly the self-host commercial users we want. No.
- **Elastic License 2.0** — close second on restriction shape (its three limitations literally include "you may not provide the software to third parties as a hosted or managed service"), and it's short. But it **never converts to OSS**, carries "Elastic" branding baggage, and gives the community no long-term guarantee. Conversion is a core requirement, so it loses. *We do* reuse its managed-service language as a model if we ever need a non-converting enterprise license (below).
- **BSL 1.1** — functionally a superset of FSL but with the parameterization risk above and a default 4-year clock. FSL is "BSL, done for you." Pick FSL.
- **"Fair Source"** — not a license; it's the *category* FSL belongs to (fair.io: source-available, minimally restricted, converts to OSS, ≤ N years). We should *describe ourselves as Fair Source* in marketing and list on fair.io, while the actual license is FSL.

**One concrete correction to the scaffold (load-bearing):** the file is titled `FSL-1.1-Apache-2.0`, but the **registered SPDX identifier is `FSL-1.1-ALv2`** (Apache License v2 future license). Tools (GitHub license detection, SPDX scanners, `license-checker`) key off the SPDX id. We must use `FSL-1.1-ALv2` as the SPDX identifier in `package.json` `"license"` fields and in per-file SPDX headers, while we can keep the human-readable title. Using a non-existent SPDX string makes GitHub show "license not detected" and breaks downstream scanners.

### Release engineering: **keep single-version semantic-release; add real publishing.**

The scaffold's single-version `.releaserc.json` is the **right** call for swarmy — do **not** migrate to `semantic-release-monorepo` or `multi-semantic-release`. Rationale, weighed:

- **swarmy ships as a deployable system, not a library set.** Every `@swarmy/*` package is `"private": true` and `version: 0.0.0`; the *artifacts users consume* are two container images (agent, controller) + a dashboard bundle + an install script. Those move together. A controller at 1.4.0 talking to an agent at 1.9.2 is a support nightmare; the **wire protocol in `@swarmy/core` is shared by both**, so a single repo-wide version is also a clean *protocol* version. One number for the whole product is a feature, not a limitation.
- **`semantic-release-monorepo`** (per-package, commit-to-package by touched paths) and **`multi-semantic-release`** (independent versions, rewrites local dep ranges at release time) solve a problem we don't have (publishing N independently-versioned npm libraries) and add real complexity: per-package `.releaserc`, tag namespacing (`@swarmy/core@1.2.0`), and the classic "a `core` change should bump everything that depends on it" fan-out that we'd have to model by hand. Skip it.
- The cost of single-version is "a `fix(ui)` bumps the whole product's patch number even if `agent` didn't change." For a deploy-it product that is *correct* behavior, and it keeps the mental model trivially simple — which is the whole brand.

So: **one version, tagged `vX.Y.Z`, applied to both images and the install script.** semantic-release stays the brain; we bolt publishing onto it via a custom `@semantic-release/exec` step + the existing CI, and we **sync the computed version into every workspace `package.json`** so images and `--version` flags report it.

Concrete release plugin chain (extends current `.releaserc.json`):
1. `@semantic-release/commit-analyzer` + `release-notes-generator` (have it) — switch both to the **conventionalcommits** preset for nicer changelog sections and `BREAKING CHANGE` handling.
2. `@semantic-release/changelog` (have it).
3. `@semantic-release/exec` (**add**) — `verifyConditionsCmd` checks registry creds; `prepareCmd` runs a `scripts/set-version.ts` that writes `nextRelease.version` into all workspace `package.json`s + an `apps/*/src/version.ts` constant; `publishCmd` is a no-op here (image build/push happens in the workflow *after* semantic-release tags, keyed off the new tag) **or** we do the buildx push in `publishCmd` so it only runs on a real release. Recommend the latter for atomicity.
4. `@semantic-release/npm` with `npmPublish: false` (have it) — keep only to bump the root version file; do **not** publish private packages.
5. `@semantic-release/github` (have it) — attach install script + SBOM + checksums as release assets.
6. `@semantic-release/git` (have it) — commit `CHANGELOG.md` + the version-synced `package.json`s back with `[skip ci]`.

## Architecture & integration

This epic is mostly *repo infrastructure*, so "integration" means files, workflows, and one tiny runtime surface (a version endpoint). No new wire-protocol messages, db models, or agent capabilities are strictly required — with two small, high-value exceptions noted under "version skew."

### License materialization across the monorepo

- **Root `LICENSE.md`** — keep (FSL text is correct). Add a top-line `SPDX-License-Identifier: FSL-1.1-ALv2`.
- **Per-package `package.json`** — set `"license": "FSL-1.1-ALv2"` in every `@swarmy/*` package and app (currently absent). Even though they're `private`, this is what scanners read.
- **Per-file SPDX headers** — add `// SPDX-License-Identifier: FSL-1.1-ALv2` to source file headers. Enforce with a lightweight check rather than hand-maintenance: add an ESLint rule (`eslint-plugin-header` or `eslint-plugin-license-header`) wired into the `lint` task, or a standalone `scripts/check-license-headers.ts` run in CI. **MVP:** headers only on the two *distributed* entry surfaces (`apps/agent`, `apps/api`) + `packages/core` (the protocol, which others may vendor); backfill the rest later. The header check must run in `bun lint`.
- **`NOTICE`** (add) — attribution for bundled deps; required hygiene once we ship Apache-2.0-converted artifacts and OSS deps inside images.
- **`README.md` License section** — already present (line 93); expand to the plain-language ✅/❌/⏳/💼 summary that's currently only in `LICENSE.md`, and link to a future `/license` page on the marketing site (`apps/web`).
- **Open-core split (design now, build later).** Establish the *convention* so it's cheap when the first enterprise feature lands:
  - Enterprise/commercial-only code lives under a clearly fenced path, e.g. `packages/enterprise/*` and `apps/*/src/ee/**`, each carrying its **own** `LICENSE` (a non-converting commercial license — model it on **Elastic License 2.0** wording, since enterprise modules should *not* auto-convert to Apache in 2 years).
  - A `LICENSING.md` at root explains the split: "everything is FSL-1.1-ALv2 and converts to Apache-2.0 in 2 years, **except** files under an `ee/`/`enterprise/` path, which are commercial-licensed and do not convert."
  - Build-time feature gating, not secret repos: the open-core code is in the same tree, gated behind a license-key check at runtime so the community build simply doesn't enable EE features. (Keeps "one repo, one build" — simplicity.) The license-key verification module itself is the first EE-licensed file.
  - **CLA / DCO:** require a **DCO** (`Signed-off-by`, enforced by commitlint/CI) for community contributions — lightweight, no paperwork — and note in `CONTRIBUTING.md` that contributions are inbound under FSL. A full CLA (assigning us relicensing rights) is heavier; defer unless an enterprise contributor needs it. Current `CONTRIBUTING.md` already states inbound = FSL; add the DCO requirement.

### Version skew handling (small runtime surface — the one place release eng touches the protocol)

The agent dials the controller over the `register` envelope in `@swarmy/core`. Two cheap additions make the single-version model self-enforcing and observable:

- **`agentVersion` + `protocolVersion` on the `register` message** (extend the existing Zod `register` schema in `packages/core/src/protocol`). The controller logs/stores it on the `Node` model (**add `agentVersion String?` to the `nodes` Prisma model**) and surfaces it in the dashboard nodes table. This is how an operator sees "node-3 is running an old agent."
- **A controller→agent advisory** when `protocolVersion` is incompatible (reuse the existing command pattern; or just refuse `register` with a typed close code, mirroring the existing `4409` close-code convention the ingress doc references). MVP: warn + display; do not hard-block (the FSL/Apache promise is about license, not forced upgrades).
- **`GET /version` on the controller (apps/api)** and `swarmy-agent --version` (apps/agent) both read the `version.ts` constant written at release time. Trivial, but it's what every support interaction and the install script's post-install check will hit.

These are the only protocol/db touches, and they're additive + optional.

### CI/CD pipeline (the bulk of the work)

Restructure into three workflows. Keep `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile`, Turbo caching.

**`ci.yml` (PR + push to main) — expand from typecheck/build to a real gate:**
- `verify` job: `lint` (turbo — **add a real `lint` task**, currently the root script exists but no package defines `lint`; wire ESLint + the license-header check), `typecheck`, `build` (have these).
- `test` job (**new**): bring up Postgres as a service container (the workflow already sets `DATABASE_URL` to localhost:5432 but **starts no Postgres** — that's a latent bug), `db:push`, `turbo run test`. Add a **`test` task** to every package/app (currently no package has one) — start with `bun test` smoke tests for `@swarmy/core` protocol round-trips and the ingress drivers, since those are pure and high-value.
- `e2e` job (**new, optional/path-filtered**): the `apps/e2e` workspace exists; run it against a `docker compose up` of controller+Postgres+a local agent on PRs that touch `apps/*` or `packages/core`.
- `images-dryrun` job (**new**): on PRs, `docker buildx build` both images **without push** to catch Dockerfile breakage before main. (Only `apps/agent/Dockerfile` exists today — see below.)
- `commitlint` job (have it).
- Use Turbo remote cache (or `actions/cache` on `.turbo`) so `verify`/`test`/`images` share build output.

**`release.yml` (push to main) — from "tag only" to "ship":**
- Run `verify` + `test` first (gate the release on green CI — currently release re-runs build but not tests).
- `bunx semantic-release` computes version, writes `CHANGELOG.md`, syncs version into `package.json`s + `version.ts`, tags `vX.Y.Z`, cuts the GitHub release.
- **Container publishing (new):** `docker/setup-buildx-action` + `docker/login-action`, build **multi-arch (`linux/amd64,linux/arm64`)** images for **both** agent and controller, tag `:X.Y.Z`, `:X.Y`, `:latest`, `:sha-<short>`, push to **GHCR** (`ghcr.io/swarmy/agent`, `ghcr.io/swarmy/controller`) as the canonical registry, and optionally mirror to Docker Hub (`swarmy/agent`, `swarmy/controller`) for discoverability. Driven from semantic-release's `publishCmd` (so it only fires on an actual release) using the freshly written version. Generate **SBOMs** (buildx `--sbom=true` / Syft) and **provenance** (`--provenance=true`), and **sign images with cosign** (keyless / OIDC) — cheap supply-chain credibility for the enterprises we'll sell to.
- **Install script publishing (new):** template `scripts/install.sh.tpl` → emit `install.sh` with the released version pinned, attach it as a GitHub release asset, and publish it to a stable URL (the marketing site `apps/web`, e.g. `https://get.swarmy.dev`, or a `gh-pages`/CDN). Also publish `checksums.txt` + `cosign` signature for the script so `curl … | sh` is verifiable.

**`Dockerfile`s:**
- **`apps/api/Dockerfile` (new)** — controller image, same workspace-prune pattern as the existing agent Dockerfile (copy root `package.json` + `bun.lock`, the needed package manifests, `bun install --filter`, then sources). Must `prisma generate` at build (db package's `build` already does this) and run migrations on boot or via an init step.
- **`apps/agent/Dockerfile`** — exists and is good; the workspace-prune approach is already correct. Just ensure the version constant is baked.
- Consider a shared base stage to keep layers cached across both.

### The install script (the "one command" promise — its real home is here)

`scripts/install.sh` is *the* user-facing artifact of this epic. It must:
- Detect Docker (and that Swarm is/can be initialized), arch, and OS.
- For the **controller**: `docker run`/compose the pinned `ghcr.io/swarmy/controller:X.Y.Z` + Postgres (or point at an external DB), generate `BETTER_AUTH_SECRET`, print the first-run URL + a join token.
- For an **agent**: emit the exact `docker run … swarmy/agent:X.Y.Z` line (the agent Dockerfile header already documents this), with `AGENT_WS_URL` + `SWARMY_JOIN_TOKEN` filled in.
- Pin to the **release version it was generated for** (no floating `latest` in the copy/paste path) and verify the image digest.
- Be idempotent and re-runnable.

This is generated *per release* so the version is always correct — which is exactly why it belongs in the release pipeline, not as a static file.

### Branch / PR conventions (formalize what CONTRIBUTING.md hints at)

- **Trunk-based on `main`.** Feature branches → PR → squash-or-merge into `main`. `main` is always releasable; every merge can trigger a release.
- **Conventional Commits enforced** (commitlint, have it). The **PR title** must also be conventional (add a `amannn/action-semantic-pull-request` check) because squash-merges use the PR title as the commit subject — this is the actual input to semantic-release on squash. Currently only individual commits are linted; squash makes the **PR title** the thing that matters.
- **Scopes** already enumerated in `commitlint.config.mjs` (workspace names + `deps/ci/release/docs/repo`). Add `enterprise`/`ee` scope when the open-core split lands.
- **`[skip ci]`** on the release bot's own commit (have it) to avoid loops.
- **Pre-release channels:** support `next`/`beta` branches in `.releaserc.json` `branches` for `X.Y.Z-beta.N` images, so the team can dogfood the hosted cloud on pre-releases without cutting stable.
- **Branch protection on `main`:** require `verify` + `test` + `commitlint` + PR-title check green; require the release workflow's token to bypass (it pushes the changelog commit). Note the existing `persist-credentials: false` in release.yml — pushing the `@semantic-release/git` commit back needs a token with `contents:write` (the `GITHUB_TOKEN` already granted) **or** a dedicated app token if branch protection blocks the default token.

## MVP vs later

**Phase 0 — License correctness (hours, do first):**
- Fix SPDX id to `FSL-1.1-ALv2` in `LICENSE.md` header + add `"license"` to every `package.json`.
- Add `LICENSING.md` (open-core convention) + `NOTICE`. Expand README license summary. Add DCO note to `CONTRIBUTING.md`.

**Phase 1 — Ship images + install (the actual gap that blocks adoption):**
- `apps/api/Dockerfile`. `scripts/set-version.ts` + `apps/*/src/version.ts`. `GET /version` + `--version`.
- `@semantic-release/exec` wired to multi-arch GHCR push for agent + controller.
- `scripts/install.sh.tpl` → generated install script as a release asset + stable URL.
- Switch commit-analyzer/notes to the conventionalcommits preset.

**Phase 2 — Pipeline hardening:**
- Real `lint` + `test` tasks across packages; Postgres service in CI; release gated on green tests; image build dry-run on PRs; PR-title conventional check; branch protection.
- cosign signing + SBOM + provenance + checksums.

**Phase 3 — Trust + open-core scaffolding:**
- Per-file SPDX header enforcement in lint (backfill all packages).
- `next`/`beta` pre-release channels.
- `packages/enterprise` + `apps/*/src/ee` fence with EE license file + runtime license-key gate (first EE module). `agentVersion`/`protocolVersion` skew display in dashboard.
- List on fair.io; `/license` marketing page.

## Dependencies

- **Registry creds:** GHCR works with the built-in `GITHUB_TOKEN` (`packages:write`); Docker Hub mirror + cosign keyless need org secrets / OIDC config. Blocks Phase 1 image push.
- **Marketing site (`apps/web`) / DNS** for the stable install URL (`get.swarmy.dev`) and `/license` page. Phase 1 install can ship via GitHub release asset URL first, then move to the vanity domain.
- **DB epic / migrations:** controller image needs a migration-on-boot story; coordinate with the datastore/backup epic so the image's entrypoint runs `prisma migrate deploy` safely.
- **Ingress epic:** the install script's "first-run URL" + the controller's public URL tie into ingress defaults; the `4409`-style close-code convention for protocol-skew refusal should match what ingress/gateway already use.
- **`@semantic-release/exec`** is a new devDependency (the only new release dep). Everything else (changelog, git, github, npm, commit-analyzer, notes) is already installed.
- **Org/audit:** no dependency — this epic is org-agnostic infra.

## Risks & open questions

- **SPDX mismatch (`-Apache-2.0` vs `-ALv2`)** silently breaks GitHub license detection and scanners today. Must fix in Phase 0. (Confirmed: SPDX-registered id is `FSL-1.1-ALv2`.)
- **Squash-merge ↔ semantic-release:** if the team squash-merges, only the PR title feeds the version bump; a `feat:` PR squashed under a `chore:` title silently won't release. The PR-title check is not optional if we squash. Decide merge strategy explicitly and enforce it.
- **Single-version "noise":** every release bumps the whole product even for a docs-scoped `feat`. Mitigate by keeping `docs/chore/refactor/test/ci/style` as no-release types (already the case) so only `feat`/`fix`/`perf`/breaking move the number.
- **FSL "Competing Use" is broad by design** — "substantially similar functionality" could chill a contributor who wants to build an adjacent tool. Mitigate with the plain-language summary + a public FAQ ("consulting/agency use is fine; reselling swarmy-as-a-service is not") and the 2-year Apache conversion as the relief valve. Get the final text + the enterprise license reviewed by counsel before GA (the LICENSE.md already disclaims this).
- **Multi-arch builds are slow** (arm64 via QEMU emulation can 5–10× a job). Mitigate with native arm64 runners (GitHub now offers them) or buildx layer cache; otherwise releases get slow. Open question: arm64 native runners vs QEMU now.
- **Migration-on-boot vs separate migrate step** for the controller image: auto-migrate is simplest (one-command promise) but risky for multi-replica controllers (concurrent migrations). Likely: a leader-elected or one-shot migrate before serving. Resolve with the DB epic.
- **cosign/SBOM scope creep:** valuable for enterprise trust but not blocking community adoption; keep in Phase 2 so it doesn't delay the thing people actually need (published images).
- **Open question:** do we publish the npm packages at all (e.g. `@swarmy/core` so third parties can build compatible agents/tools)? Current stance: no (`npmPublish:false`, all `private`). If we later want an ecosystem, `@swarmy/core` is the one package worth publishing — and single-version semantic-release makes that a one-line change. Defer.

## Simplicity note

This epic *is* the one-command promise, viewed from the supply side. The whole point of single-version releases + a per-release install script + published multi-arch images is that the user's entire experience is:

```sh
curl -fsSL https://get.swarmy.dev | sh        # controller, pinned, verified
docker run … ghcr.io/swarmy/agent:X.Y.Z …     # one line per node, version matches
```

No version matrix to reason about (controller and agent share one number = the protocol version), no build step, no "which package do I install," nothing to configure to get a running, HTTPS-able controller. The license stays out of the way too: the FSL plain-language summary means a self-hoster never has to read legalese to know "yes, I can run this for my company and my clients." Every decision in this doc — one version, one install command, images that just exist at predictable tags, a license that converts to Apache and reads in 30 seconds — is in service of "anyone can just deploy."
