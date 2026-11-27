---
paths:
  - '.github/workflows/**'
  - 'packages/trpc/src/services/{cicd,image-gc,registryPolicy,admission-images}*'
  - 'apps/agent/src/handlers/{build,prune}.ts'
  - 'scripts/records*'
  - 'docs/decisions/**'
  - 'docs/requirements/**'
---

# CI, registry and records

Load `cicd-registry` for builds and the registry, `testing-conventions` for tests and CI.

- DR-012: builds are an agent command on your own builder nodes, rootless BuildKit.
- DR-014, DR-015: one `registry:2` service; deploy by digest, never a floating tag.
- DR-016: one GitHub App per install, short-lived tokens.
- DR-046: the dashboard writes to git through pull requests only (BR-037).
- DR-001: records change only through the process in `docs/decisions/README.md`; never set
  Accepted or Rejected; run `bun run scripts/records.ts check` after any record change.
