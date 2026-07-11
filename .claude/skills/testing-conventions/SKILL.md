---
name: testing-conventions
description: How swarmy tests are laid out, run, and gated — the `bun test` colocation convention, inline fixtures/golden style, the five required CI gates (protocol round-trip/discriminated-union parse, compose two-way golden corpus, ABAC policy units, GC never-delete-in-prod-digest, headline install→ONLINE→deploy→reachable e2e), and the conventional-commit PR-title rule that feeds semantic-release. Load before adding a test, a package, or a CI job, or when wiring a feature's test gate. This is the testing authority for swarmy; it has no paired product doc — the WHY is inline.
---

# Testing conventions: `bun test`, inline fixtures, five gates

This is the testing authority for swarmy. There is no paired product doc — the
rationale lives here. When you build a feature slice (`skill("add-feature-slice")`)
or an agent capability (`skill("agent-handlers")`), the gate your change must add
is defined below. To run the app under test locally, see `skill("run-local")`.

## Invariants (violating any of these is a bug, not a style choice)

1. **The runner is `bun test` (bun's built-in), never vitest/jest.** Every
   workspace's `package.json` has `"test": "bun test"`; every test file imports
   `{ describe, expect, it } from 'bun:test'`. Root `bun run test` → `turbo run
   test`, whose pipeline `dependsOn: ["^build"]` (turbo.json) so a package's deps
   are built before its tests run. Do not add a vitest/jest config.
2. **Tests are colocated as `*.test.ts` next to the source they cover** —
   `packages/dns/src/answer.test.ts`, `apps/agent/src/handlers/mesh.test.ts` — not
   a top-level `test/` tree. The file under test and its test are siblings so a
   package moves as one unit.
3. **Fixtures are inline literals, not a `fixtures/` directory.** There is no
   `fixtures/`/`__fixtures__/` anywhere. Sample inputs are `const`s at the top of
   the test (compose `SAMPLE` in `round-trip.test.ts`) and reusable shapes are
   local factory helpers (`principal()`/`resource()`/`policy()` in
   `abac/src/engine.test.ts`, `cand()` in `image-gc.test.ts`, `mockCtx()` in
   `trpc/src/abac.test.ts`). "Golden" means the expected value is a literal in the
   assertion — there are no snapshot files to regenerate.
4. **Unit tests exercise PURE logic directly; no Docker socket, no live DB.**
   swarmy's design pushes logic into pure functions (`computeGcPlan`,
   `buildCaddyfile`, `composeToModels`, `JsonPolicyEngine.evaluate`,
   `answerQuery`) so the test imports the function and asserts on its return.
   Controller-service tests mock the context in-memory (`mockCtx`) — they don't
   spin Postgres. If a change is only testable against a real socket/DB, the logic
   is in the wrong place; move it into `packages/*` and test it there (same rule
   the DNS/ingress "render pure, apply at the edge" split enforces).
5. **Every protocol message has a round-trip / discriminated-union parse test.**
   The pattern (`packages/core/src/protocol/swarm.test.ts`): `safeParse` a minimal
   payload and assert defaults; `safeParse` a wrong/partial payload and assert
   `.success === false`; wrap it in its `…Msg` and assert the `type` discriminant;
   feed a wrong `type` literal and assert rejection. A new
   `ControllerToAgentMessage` variant is not done until it has this test — an
   unparsed frame is dropped silently on the wire, so the test is the only thing
   that catches a bad schema.
6. **The five required CI gates are load-bearing, not optional** (ROADMAP
   "Testing" cross-cut). Each headline capability owns one:
   protocol parse (inv. 5), compose two-way golden round-trip
   (`packages/core/src/compose/*.test.ts`), ABAC policy units
   (`packages/abac/src/*.test.ts` + `trpc/src/abac.test.ts`), GC "never prune the
   in-prod digest" (`trpc/src/services/image-gc.test.ts`), and the headline e2e
   (`install.sh` → node ONLINE → deploy → reachable over ingress). Deleting the
   last assertion of any of these is a regression in the gate, not cleanup.
7. **The GC test's job is to prove a digest running in prod is never removed.**
   `computeGcPlan` tests assert `plan.remove` never contains a pinned digest under
   every mode (AGE_DAYS, ON_HEALTHCHECK), including when the pin is a full
   `repo@sha256:` ref, and that `keepProd:false` is the only way to disable it.
   This is a safety invariant of `skill("cicd-registry")`; treat it like the
   never-empty-DNS-answer rule — the test defends a promise, not a code path.
8. **The PR title must be a valid Conventional Commit** (`commitlint.config.mjs`).
   Squash-merge uses the PR title as the commit subject, which is the actual input
   to semantic-release (`feat:`→minor, `fix:`/`perf:`→patch, `BREAKING CHANGE`→
   major). A `feat:` PR merged under a non-conforming title silently fails to
   release. Scope, when present, must be in the workspace enum (`core`, `db`,
   `auth`, `ingress`, `trpc`, `ui`, `api`, `agent`, `app`, `web`, `e2e`, `deps`,
   `ci`, `release`, `docs`, `repo`).
9. **e2e is layered by what it needs running.** Marketing smoke
   (`apps/e2e/tests/smoke.spec.ts`, no backend, its own `webServer`), demo smoke
   (`apps/e2e/demo-smoke.ts` — serves the built dashboard in demo mode, proves it
   renders with NO API/DB), and the headline backend e2e (real install → ONLINE →
   deploy → reachable). Keep the no-backend tiers no-backend; don't make the
   marketing smoke depend on Postgres.

## Contracts between the layers

- **Turbo → workspaces**: `turbo run test` fans out to each workspace's `bun
  test` after `^build`. A package with no test file still passes (bun test exits 0
  on no matches) — absence is silent, so a required gate must be an actual file.
- **CI → gates** (`.github/workflows/`): `ci.yml` `verify` job runs
  `typecheck` + `build` + Prisma schema validate against a real `postgres:16`
  service (`DATABASE_URL` wired to it) and `images-dryrun` builds both Dockerfiles
  without pushing; `commitlint` lints PR commits; `pr-title.yml` lints the PR
  title; `release.yml` runs semantic-release on `main`. **A `bun run test` job is a
  known P0 gap** (ROADMAP: "CI today runs no lint/test") — when you add it, it
  needs the same Postgres service block as `verify` for any DB-touching test.
- **Test → source purity**: a test importing from `@swarmy/core`,
  `@swarmy/ingress`, `@swarmy/dns`, `@swarmy/abac`, `@swarmy/mesh` gets pure
  functions; a test in `packages/trpc/src/services` mocks `OrgContext`/the hub.
  Neither opens a Docker socket. That boundary is the contract that keeps the
  suite fast and hermetic.

## File map

| Concern | Where |
|---|---|
| Runner + colocation convention | each workspace `package.json` `"test": "bun test"`; files `**/src/**/*.test.ts` |
| Turbo test pipeline (`^build` dep) | `turbo.json` |
| Protocol round-trip / union parse (the pattern) | `packages/core/src/protocol/swarm.test.ts` (over `packages/core/src/protocol/*`) |
| Compose two-way golden round-trip corpus | `packages/core/src/compose/round-trip.test.ts`, `to-spec.test.ts` |
| ABAC / Cedar policy units | `packages/abac/src/{engine,cedar,build,grants}.test.ts`, `packages/trpc/src/abac.test.ts` |
| GC "never delete in-prod digest" | `packages/trpc/src/services/image-gc.test.ts` (`computeGcPlan`, `bareDigest`) |
| Ingress/render golden (site-block ordering) | `packages/ingress/src/render/{caddyfile,cold,nginx}.test.ts` |
| DNS core (steer/answer/wire/compose/signature) | `packages/dns/src/*.test.ts` |
| Controller-service units (mock `OrgContext`) | `packages/trpc/src/services/*.test.ts` (~50 files) |
| Agent handler units | `apps/agent/src/handlers/{mesh,terminal,prune}.test.ts` |
| Marketing smoke (no backend) | `apps/e2e/tests/smoke.spec.ts`, `apps/e2e/playwright.config.ts` |
| Demo smoke (built dashboard, no API/DB) | `apps/e2e/demo-smoke.ts` |
| CI gates | `.github/workflows/{ci,pr-title,release,images}.yml` |
| Conventional-commit rules (scopes = workspaces) | `commitlint.config.mjs` |
| Release-engineering rationale | `plans/epic-licensing-release-engineering.md`, `plans/ROADMAP.md` (Testing cross-cut) |

## Adding a test (the recipe)

1. **Put it next to the source**: `foo.ts` → `foo.test.ts`, importing
   `{ describe, expect, it } from 'bun:test'` and the real exports from `./foo`.
2. **Inline the fixture**: a `const` sample or a small factory helper at the top;
   assert against literal expected values (that's your golden).
3. **If it's a protocol message**, follow the `swarm.test.ts` shape: parse valid +
   invalid payloads, wrap in the `…Msg`, assert the discriminant and reject a
   wrong `type` literal.
4. **If it's a controller service**, mock `OrgContext` in-memory (see
   `trpc/src/abac.test.ts` `mockCtx`) — never reach for a live socket or DB.
5. **If it's a required gate** (a new headline capability), make sure the gate is a
   real file so Turbo's silence-on-no-match doesn't hide it, and name the invariant
   it defends in the test's `describe`.
6. **Verify locally**: `bun --filter @swarmy/<pkg> test` for the package, or
   `bun run test` for the whole graph; then `bun run typecheck`. For e2e, run the
   relevant tier (`bun --filter @swarmy/e2e test:e2e`, or the demo build →
   `bun apps/e2e/demo-smoke.ts`). Confirm the PR title is a conventional commit
   with a scope from the enum before opening the PR — that's the gate that decides
   whether the change ships.

## Operational gotchas

- `bun test` exits 0 when a package has **no** `*.test.ts` — a deleted or
  never-written required gate reads as green. Assert gate presence by file, not by
  a passing run.
- Golden assertions are literals, so an intended behaviour change means editing the
  expected value in the test in the same commit — there's no `--update-snapshots`.
  A diff that flips a golden without a matching source change is the tell.
- The full headline e2e needs the controller + app + Postgres up (point Playwright
  `baseURL` at `:3023` per `playwright.config.ts`'s note) and a box to enroll — use
  the `scripts/local-vms.sh` Lima swarm (`skill("run-local")`), not the
  marketing `webServer`.
- Don't add a `scope` to a PR title that isn't in `commitlint.config.mjs`'s
  `scope-enum` — commitlint warns (level 1) but a typo'd scope still muddies the
  changelog semantic-release generates.
