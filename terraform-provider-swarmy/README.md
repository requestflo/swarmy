# terraform-provider-swarmy

A Terraform provider for [swarmy](../), letting a swarm's nodes, services, stacks,
and ingress domains live in `.tf` and be `plan`/`apply`/`destroy`-ed in CI
alongside the rest of your infrastructure.

> **Status: implemented (v0.1).** A hand-written provider on the
> [terraform-plugin-framework](https://developer.hashicorp.com/terraform/plugin/framework)
> with a typed REST client lives in this directory. It is intentionally **not**
> part of the TypeScript monorepo build (it has its own Go module + toolchain,
> `go 1.24`). See [Build / install / use](#build--install--use) below.

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
      source  = "registry.terraform.io/requestflo/swarmy"
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

The implemented resources and data sources are listed in
[Resources & data sources (implemented)](#resources--data-sources-implemented)
below. (`swarmy_join_token`, `swarmy_backup_target`, and richer ingress config
land with later phases / their owning epics.)

## Generation boundary (don't clobber hand code)

- **Generated:** the Go SDK (`internal/sdk`, regenerated wholesale) and simple
  CRUD resource scaffolding where Speakeasy `x-speakeasy-entity` annotations fit.
- **Hand-written:** `internal/provider/*` — async reconcile, drift read,
  `ForceNew` rules, import IDs. These only *call* the SDK, so regeneration never
  touches them.

## Layout (planned)

```
terraform-provider-swarmy/
├── README.md                  # this file
├── openapi.json               # committed spec reference (copy of the canonical export)
├── GNUmakefile                # build / install / test / testacc targets
├── go.mod / go.sum            # Go module (keeps Go out of the TS build)
├── main.go                    # provider entrypoint (providerserver.Serve)
├── internal/
│   ├── client/                # typed REST client: auth, JSON, RFC9457 errors
│   │   ├── client.go          # transport, URL building, GET/POST/DELETE helpers
│   │   ├── api.go             # per-resource calls (services, stacks, domains, …)
│   │   ├── models.go          # DTO structs (snake_case JSON)
│   │   ├── errors.go          # APIError + problem+json mapping + IsNotFound
│   │   └── client_test.go     # unit tests: URL building, error mapping
│   └── provider/              # hand-written resources/data-sources
│       ├── provider.go        # schema, env fallbacks, Configure
│       ├── helpers.go         # shared conversion helpers
│       ├── resource_service.go, resource_stack.go,
│       │   resource_domain.go, resource_api_key.go
│       ├── data_source_node.go
│       ├── provider_test.go   # fast schema-validity unit tests
│       └── resource_service_acc_test.go  # TF_ACC-gated acceptance test
└── examples/                  # *.tf usage examples (provider, resources, data-sources)
```

## Build / install / use

The provider is a standalone Go module (`go 1.24`). All commands run from this
directory.

```sh
# Compile, vet, unit-test (no live controller needed):
make build
make vet
make test

# Or directly:
GOFLAGS=-mod=mod go mod tidy
go build ./...
go vet ./...
go test ./internal/client/...
```

Install into the local Terraform plugin mirror so `terraform init` resolves it:

```sh
make install
# copies the binary to
# ~/.terraform.d/plugins/registry.terraform.io/requestflo/swarmy/<version>/<os>_<arch>/
```

Then in a config (see `examples/`):

```hcl
terraform {
  required_providers {
    swarmy = {
      source  = "registry.terraform.io/requestflo/swarmy"
      version = "~> 0.1"
    }
  }
}

provider "swarmy" {
  endpoint = "https://controller.example.com" # or SWARMY_ENDPOINT
  # api_key sourced from SWARMY_API_KEY
}
```

```sh
export SWARMY_ENDPOINT="https://controller.example.com"
export SWARMY_API_KEY="swk_…"
cd examples && terraform init && terraform plan
```

### Acceptance tests

Acceptance tests are gated behind `TF_ACC` (so `go build`/`go vet`/`go test`
stay green without a server) and require a live controller:

```sh
SWARMY_ENDPOINT=… SWARMY_API_KEY=swk_… make testacc
```

## Resources & data sources (implemented)

| Terraform | REST backing | Lifecycle |
|---|---|---|
| `swarmy_service` | `POST/GET/DELETE /services`, `/services/{id}/scale`, `/services/{id}/restart` | Async create (202) → read-back. `name`/`node_id` force replace; `replicas` → scale; `image` → restart/redeploy. Import by ID. |
| `swarmy_stack` | `POST/GET/DELETE /stacks` | Async deploy (202) → read-back. Update redeploys the compose source. Import by ID. |
| `swarmy_domain` | `GET/POST /ingress/domains`, `DELETE /ingress/domains/{id}` | Plain CRUD. No update endpoint, so attribute changes delete+recreate. Read filters the list by ID. Import by ID. |
| `swarmy_api_key` | `POST/GET/DELETE /api-keys` | Token returned once on create, stored sensitive in state. `name`/`scopes` force replace. |
| `data.swarmy_node` | `GET /nodes`, `GET /nodes/{id}` | Lookup by `id` or `name` (exactly one). |

## Caveats

- **`swarmy_api_key` has no spec backing yet.** `openapi.json` does not ship an
  `/api-keys` endpoint. The client/resource follow the documented convention
  (`POST /api-keys` with `{name, scopes}` returning a one-time `token`); wire the
  paths to the real endpoint once it lands. Everything else maps to endpoints
  present in `openapi.json`.
- **Async reconcile is read-after-create**, not deployment-phase polling. Create/
  update dispatch the async deploy (202) and immediately read the resource back
  to populate computed fields. A future revision can poll the returned
  `deployment_id` to a terminal phase.
- **`image`/`command`/`env`/`compose_source` are not echoed** by the read DTOs,
  so they are preserved from plan/state rather than refreshed from the API.

## Publish (future)

- `goreleaser` builds the multi-platform provider binaries.
- Published to the [Terraform Registry](https://registry.terraform.io) on release.
