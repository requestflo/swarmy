# terraform-provider-swarmy

A Terraform provider for [swarmy](../), letting a swarm's nodes, services, stacks,
and ingress domains live in `.tf` and be `plan`/`apply`/`destroy`-ed in CI
alongside the rest of your infrastructure.

> **Status: scaffold.** This directory documents the provider plan and holds the
> committed OpenAPI reference. The Go implementation is intentionally **not** part
> of the TypeScript monorepo build (it has its own Go module + toolchain). MVP
> ships the controller-side REST API + `openapi.json`; the provider is Phase 3 of
> the epic (`../plans/epic-rest-api-terraform.md`).

## How it fits together

```
@swarmy/api-rest  ──emit──▶  openapi.json  ──codegen──▶  Go SDK  ──used by──▶  provider
 (Zod routes)                (committed spec)            (Speakeasy)          (this dir)
```

1. **Generated Go SDK** from `openapi.json` via [Speakeasy](https://speakeasy.com)
   (fallback: `openapi-generator`). Fully regenerated on every API change — no
   hand-maintained HTTP code.
2. **Hand-written provider** on the
   [Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework)
   (current-gen; `terraform-plugin-sdk/v2` is legacy). It maps Terraform
   resources/data-sources onto SDK calls and owns the state model, the
   create→poll-deployment→read reconcile loop, import support, and `ForceNew`/diff
   semantics.

## The committed OpenAPI reference

The provider (and the SDKs) are generated from a **committed spec** so codegen
and review have a stable artifact and breaking changes show up in PR diffs.

- Source of truth: the Zod route definitions in `packages/api-rest`.
- Regenerate the committed spec:

  ```sh
  bun run --filter @swarmy/api-rest openapi:dump
  # writes packages/api-rest/openapi.json
  ```

- Reference copy for provider codegen lives at
  [`./openapi.json`](./openapi.json); refresh it from the canonical export:

  ```sh
  cp ../packages/api-rest/openapi.json ./openapi.json
  ```

A CI drift test (TODO) fails if the generated spec differs from the committed
one, and `oasdiff` gates breaking changes within a major version.

## Provider configuration

```hcl
terraform {
  required_providers {
    swarmy = {
      source  = "swarmy-dev/swarmy"
      version = "~> 0.1"
    }
  }
}

provider "swarmy" {
  endpoint = "https://controller.example.com" # your swarmy controller
  api_key  = var.swarmy_api_key               # or SWARMY_API_KEY env var; mint in Settings → API keys
}
```

One API key is scoped to one org, so the provider operates within that org.
Read-only data sources need a `read`-scope key; managed resources need `write`.

## Resources & data sources (v1 plan)

| Terraform | REST backing | Lifecycle notes |
|---|---|---|
| `data.swarmy_node` / `swarmy_node` | `/nodes`, `/nodes/{id}` | Nodes self-register via the agent + a join token; the resource manages labels/availability/removal. |
| `swarmy_service` (+ `data`) | `/services`, `/services/{id}`, `/services/{id}/scale`, `/services/{id}/restart` | Flagship. Create/update → async deploy; provider polls the deployment to a terminal phase. `ForceNew` on name/node; in-place on image/replicas/env. |
| `swarmy_stack` | `/stacks`, `/stacks/{id}` | Compose-style bundle; async deploy/poll. |
| `swarmy_ingress_domain` (+ `data`) | `/ingress/domains` | Plain CRUD; pairs a host with a service + port + TLS mode. |

(`swarmy_join_token`, `swarmy_backup_target`, and richer ingress config land with
later phases / their owning epics.)

## Generation boundary (don't clobber hand code)

- **Generated:** the Go SDK (`internal/sdk`, regenerated wholesale) and simple
  CRUD resource scaffolding where Speakeasy `x-speakeasy-entity` annotations fit.
- **Hand-written:** `internal/provider/*` — async reconcile, drift read,
  `ForceNew` rules, import IDs. These only *call* the SDK, so regeneration never
  touches them.

## Layout (planned)

```
terraform-provider-swarmy/
├── README.md            # this file
├── openapi.json         # committed spec reference (copy of the canonical export)
├── main.go              # provider entrypoint (TODO)
├── go.mod               # Go module (TODO — keeps Go out of the TS build)
├── internal/
│   ├── sdk/             # generated Go API client (TODO)
│   └── provider/        # hand-written resources/data-sources (TODO)
└── examples/            # *.tf usage examples
```

## Build / publish (Phase 3)

- `goreleaser` builds the multi-platform provider binaries.
- Published to the [Terraform Registry](https://registry.terraform.io) on release
  (the repo already runs semantic-release for versioning).
- Acceptance tests (`TF_ACC=1`) run against a dev controller.
