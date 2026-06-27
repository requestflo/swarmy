# swarmy SDKs

Official client SDKs for the swarmy public REST API (`/api/v1`), covering
services, stacks, nodes, and ingress domains.

| Language   | Package                              | Path               | Toolchain   |
| ---------- | ------------------------------------ | ------------------ | ----------- |
| TypeScript | `@swarmy/sdk`                        | `sdks/typescript/` | Bun 1.3     |
| Python     | `swarmy`                             | `sdks/python/`     | Python 3.9+ |
| Go         | `github.com/requestflo/swarmy-go`    | `sdks/go/`         | Go 1.24     |

All three are **standalone** — they are intentionally *not* part of the Bun
workspace / Turbo graph so they never perturb the monorepo's typecheck and
build. Each compiles/imports cleanly with its own native toolchain.

## Design

Each SDK is split into two layers:

- **Hand-written, stable** transport + resource layer:
  - a `SwarmyClient` configured with `{ endpoint, apiKey }`,
  - resource groups (`services`, `stacks`, `nodes`, `ingress`) with idiomatic
    methods,
  - a `SwarmyApiError` / `APIError` that carries the RFC 9457
    `application/problem+json` document (including `swarmy_code`),
  - cursor-pagination helpers that follow `next_cursor`.
- **Generated models** (`models.ts` / `models.py` / `models.go`) — the only
  files (re)generated from the OpenAPI spec, so the typed models track the
  contract while the ergonomic surface stays put.

### Conventions

- Base URL: the client appends `/api/v1` to the endpoint (and won't double it
  if you already include it).
- Auth: `Authorization: Bearer swk_…`.
- JSON is snake_case on the wire (matching the spec); the Go SDK uses Go-idiomatic
  field names with `json:"…"` tags, Python/TS keep snake_case field names.
- Async deploy endpoints (create / scale / restart service, deploy stack) return
  a `DeploymentRef` (HTTP 202).

## Regenerating models

The model files are generated from the committed spec at
`packages/api-rest/openapi.json` by a single Bun script. **Run it from the repo
root** whenever the spec changes:

```sh
bun run scripts/gen-sdks.ts
```

It overwrites exactly these files (each carries a "do not edit by hand" banner):

- `sdks/typescript/src/models.ts`
- `sdks/python/swarmy/models.py`
- `sdks/go/models.go`

Nothing else is touched. The generator resolves `$ref`s (so list envelopes are
typed, e.g. `ServiceList.data: Service[]`), maps a couple of inline nested
objects to named types (`Service.replicas → ServiceReplicas`,
`CreateServiceRequest.env → EnvVar`), and runs `gofmt` on the Go output when
available. Re-running it is idempotent.

> The spec itself is produced from the live Zod route definitions via
> `bun run --filter @swarmy/api-rest openapi:dump`, so it cannot drift from
> request validation. Run that first if you changed the routes.

## Verifying

```sh
# TypeScript
cd sdks/typescript && bun install && bunx tsc --noEmit && bun test

# Python (pytest optional; stdlib unittest-compatible)
cd sdks/python && python3 -c "import swarmy" && python3 -m pytest

# Go
cd sdks/go && GOFLAGS=-mod=mod go mod tidy && go build ./... && go vet ./... && go test ./...
```

## Usage

### TypeScript

```ts
import { SwarmyClient, SwarmyApiError } from '@swarmy/sdk';

const swarmy = new SwarmyClient({ endpoint: 'https://swarm.example.com', apiKey: 'swk_…' });

const { data } = await swarmy.services.list();
await swarmy.services.scale('svc_123', 5);            // 202 → DeploymentRef
for await (const svc of swarmy.services.iterate()) console.log(svc.name);

try {
  await swarmy.services.get('missing');
} catch (e) {
  if (e instanceof SwarmyApiError) console.error(e.status, e.code, e.problem.detail);
}
```

### Python

```python
import swarmy

client = swarmy.SwarmyClient("https://swarm.example.com", "swk_…")
services, next_cursor = client.services.list()
client.services.scale("svc_123", 5)
for svc in client.services.iterate():
    print(svc.name)

try:
    client.services.get("missing")
except swarmy.SwarmyApiError as e:
    print(e.status, e.code, e.problem.detail)
```

### Go

```go
import (
    "context"
    "errors"
    "log"

    swarmy "github.com/requestflo/swarmy-go"
)

c, err := swarmy.NewClient("https://swarm.example.com", "swk_…")
if err != nil { log.Fatal(err) }

list, err := c.Services.List(context.Background(), "", 0)
_, err = c.Services.Scale(context.Background(), "svc_123", 5)

err = c.Services.Iterate(context.Background(), 0, func(s swarmy.Service) error {
    log.Println(s.Name)
    return nil
})

var apiErr *swarmy.APIError
if errors.As(err, &apiErr) {
    log.Println(apiErr.Status, apiErr.Code(), apiErr.Problem.Detail)
}
```
