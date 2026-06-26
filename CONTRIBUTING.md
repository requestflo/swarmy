# Contributing to swarmy

## Dev setup

```bash
bun install
bun docker:up          # Postgres on :5678
cp .env.example .env   # set BETTER_AUTH_SECRET
bun db:generate && bun db:push
bun dev                # controller (:3001) + dashboard (:3003)
```

`bun typecheck` and `bun build` run the whole graph through Turbo.

## Commit messages — Conventional Commits

Versioning, the changelog, and GitHub releases are fully automated by
[semantic-release](https://semantic-release.gitbook.io). That only works if
commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <subject>
```

| Type | Release | Example |
|---|---|---|
| `feat` | minor | `feat(app): add live node sparklines` |
| `fix` | patch | `fix(agent): reconnect after 4409` |
| `perf` | patch | `perf(api): batch metric writes` |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style` | none | `chore(deps): bump turbo` |
| any with `BREAKING CHANGE:` in body | **major** | — |

**Scopes** map to workspaces: `core`, `db`, `auth`, `ingress`, `trpc`, `ui`,
`api`, `agent`, `app`, `web`, `e2e`, plus `deps`, `ci`, `release`, `docs`, `repo`.

Commits and PR commits are linted by `commitlint` in CI.

## Branches & releases

- Work on a feature branch, open a PR into `main`.
- CI runs typecheck + build + commitlint.
- On merge to `main`, the **Release** workflow runs semantic-release: it computes
  the next version from the commits, updates `CHANGELOG.md`, tags, and publishes a
  GitHub release.

## Roadmap

The product roadmap and per-epic design docs live in [`plans/`](./plans). Start
with [`plans/ROADMAP.md`](./plans/ROADMAP.md).

## License

swarmy is licensed under the [Functional Source License](./LICENSE.md)
(FSL-1.1-ALv2). By contributing you agree your contributions are licensed
under the same terms. See the license for what is and isn't permitted (TL;DR: use
it for almost anything except reselling swarmy as a competing managed service).
