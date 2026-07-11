# Contributing to swarmy

## Dev setup

```bash
bun install
cp .env.example .env   # set BETTER_AUTH_SECRET (openssl rand -base64 32)
bun docker:up          # Postgres on :5678 (reads .env; set SWARMY_DB_PORT if taken)
bun db:generate && bun db:push
bun dev                # controller (:3021) + dashboard (:3023)
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
`api`, `agent`, `app`, `web`, `e2e`, plus `deps`, `ci`, `release`, `docs`, `repo`,
`enterprise`/`ee` (for the open-core split — see [`ee/`](./ee)).

Commits and PR commits are linted by `commitlint` in CI. Because we squash-merge,
the **PR title** must also be a valid Conventional Commit — it becomes the squash
commit subject and is the real input to semantic-release. The
[`PR Title`](./.github/workflows/pr-title.yml) check enforces this.

## Developer Certificate of Origin (DCO)

All contributions must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/). This is a
lightweight, paperwork-free affirmation that you wrote the patch (or otherwise
have the right to submit it) and agree to license it under the project's terms.
There is no CLA.

Add a `Signed-off-by` trailer to every commit — `git commit -s` does this for you:

```
Signed-off-by: Your Name <you@example.com>
```

The name/email must match the commit author. Forgot one? `git commit --amend -s`
(or `git rebase --signoff` for a range) fixes it before you push.

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

The exception is the [`ee/`](./ee) directory (and any path explicitly marked
enterprise), which is governed by the non-converting
[swarmy Enterprise License](./ee/LICENSE); contributions there are inbound under
that license. See [`ee/README.md`](./ee/README.md) for the open-core split.
