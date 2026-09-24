# The swarmy CLI and MCP server

`swarmy` is the developer CLI: sign in, link a checkout to an app, deploy,
follow logs, move env vars, and check a repo before it ever reaches the
controller. The same abilities are served to AI tools (Claude Code, Cursor,
any MCP host) by the swarmy **MCP server**, locally over stdio (`swarmy mcp`)
or remotely at `<controller>/mcp`.

Everything remote goes through the public REST API (`/api/v1`) with an
org-scoped API key, so the CLI and the MCP server can do exactly what that key
may do, and nothing more.

## Install

Your controller serves the binaries itself (macOS and Linux, arm64 and x64),
checksum-verified, the same way it serves the node agent:

```sh
curl -fsSL https://swarm.example.com/install/cli.sh | sh
```

It installs to `~/.local/bin/swarmy` (`/usr/local/bin` as root; override with
`SWARMY_INSTALL_DIR`). Binaries and checksums are also at
`/install/cli/manifest.json` and `/install/cli/<platform>` (`darwin-arm64`,
`darwin-x64`, `linux-arm64`, `linux-x64`).

## Sign in

```sh
swarmy login --controller https://swarm.example.com
```

This opens the dashboard at `/device?code=XXXX-XXXX` (the device-code flow).
Check that the code matches your terminal, then approve. The CLI receives a
new API key named `CLI · <hostname>`, which you can revoke any time in
Settings → API keys.

| Scope | What it allows | Who can grant it |
|---|---|---|
| `read` (default) | See apps, services, logs, and env with secret values hidden | Any member |
| `write` | Deploy, change env, create previews, toggle telemetry | Admins and owners |
| `secrets.read` | Read secret values (`env pull --include-secrets`); every read is audited | Admins and owners |

Ask for more with `swarmy login --scope read,write` (or `read,secrets.read`).
A key never exceeds the current role of the person who approved it, and your
org's ABAC policies still apply to every call.

Other ways to sign in:

- `swarmy login --api-key swk_…` uses a key you already have.
- `echo "$KEY" | swarmy login --with-token` reads the key from stdin.
- In CI, set `SWARMY_CONTROLLER` and `SWARMY_API_KEY`, and nothing is stored.

**Where the key is kept:** the macOS Keychain, or the Secret Service keyring
(`secret-tool`) on Linux desktops. Otherwise it goes in
`~/.config/swarmy/credentials.json` with mode `600`.

## Commands

| Command | What it does |
|---|---|
| `swarmy check [path]` | Runs locally and deploys nothing (see below) |
| `swarmy link [app]` | Links this checkout to an app (matched by git remote when omitted). Writes `.swarmy/link.json` |
| `swarmy deploy [--branch b]` | Plans and applies a branch head, like a push. Destructive steps wait for confirmation in the dashboard |
| `swarmy deploy --preview` | Builds the current branch as a throwaway preview with its own URL |
| `swarmy status` | Shows each environment with its stack, last deploy, drift, services and replicas, and previews |
| `swarmy logs [service] [-f] [-n 200] [--since 15m]` | Shows recent logs, or follows them (`-f`, streamed over SSE) |
| `swarmy env` / `env ls` | Lists env vars. Secret values show as `<secret>` |
| `swarmy env pull [.env]` | Writes plain vars to a mode-600 `.env`. Secrets are written as comments without values, unless you pass `--include-secrets` with a `secrets.read` key |
| `swarmy env push [.env] [--secret K,…] [--prune]` | Merges a `.env` into the service and rolls it out. Keys that are already secret stay secret, and `--secret` makes new ones secret (write-only Docker secrets) |
| `swarmy run -- <cmd>` | Runs a local command with the service's env injected (secrets only with `--include-secrets`) |
| `swarmy open [--dashboard]` | Opens the app's domain from `swarmy.yaml`, or its dashboard page |
| `swarmy sourcemaps upload <dir\|files…> [--release v \| --no-release] [--url-prefix ~/] [--ext js,map,mjs,cjs]` | Uploads bundles and source maps for error tracking (walks `*.js`/`*.map`; each is named `<url-prefix><relative path>`; batched under 15 MB). The release defaults to `$SENTRY_RELEASE`, then `git rev-parse HEAD`. Needs a `write` key from an admin |
| `swarmy errors dsn` | Prints the app's Sentry-compatible DSN |
| `swarmy errors rotate-key` | Rotates the DSN key; the old one stops at once. Redeploy to deliver the new one |
| `swarmy explain "<error>"` | Explains an error message; you can also pipe logs into it |
| `swarmy whoami` / `logout` | Show who you are signed in as / forget the stored key |
| `swarmy mcp [--read-only]` | Runs the MCP server over stdio |

Every command accepts `--json` for machine-readable output and `--controller`
to pick a controller. Exit codes: `0` success, `1` failure, `2` usage or
missing setup, `3` not authorised.

### `swarmy check`

`check` asks "will this repo work on swarmy?" without leaving your laptop:

1. It finds how swarmy would deploy the repo: `swarmy.yaml`, then a compose
   file, then a Dockerfile, then a stack it can detect.
2. It validates `swarmy.yaml` with the same `@swarmy/app-config` parser the
   controller runs on every push, so errors and line numbers match exactly.
3. It checks build inputs:
   - build paths exist;
   - pinned Dockerfiles exist;
   - directories without a Dockerfile get stack detection (Node/Bun/Deno,
     Python, Go, Ruby, PHP, Rust, Java, Elixir, static sites) for Railpack
     zero-config builds, with warnings such as a missing lockfile or no
     `start` script;
   - compose keys that Swarm ignores are flagged (`container_name`, `restart`,
     `build` without `image`, and others).
4. It prints the plan in plain words: resources, services, routes with TLS,
   jobs, previews and environments.
5. With no `swarmy.yaml`, it suggests a starter file that parses clean.

The exit code is non-zero when there are errors, so `check` works in CI or a
pre-push hook.

## MCP server

### Tools

Read-only tools are always available:

| Tool | Purpose |
|---|---|
| `check_repo` | "Will this work on swarmy?" Runs `check` against a local path (stdio), or against file contents you pass (HTTP) |
| `list_apps` | Lists apps, their environments and stacks, latest plan status, previews, and drift |
| `app_status` | Shows one environment's services (replicas, status, last Swarm error), latest plan (held, failed and config issues), drift, and previews |
| `logs` | Returns a service's recent log lines |
| `env` | Returns a service's env. It never reveals secret values |
| `explain_error` | Explains an error text, or reads a service's last error and logs and explains them |

Mutating tools are registered only when the key has the `write` scope and
`--read-only` is not set:

| Tool | Purpose |
|---|---|
| `deploy` | Plans and applies a branch head. Destructive steps stay held for confirmation |
| `trial_deploy` | Deploys a branch as a preview; production is untouched |
| `env_set` | Sets, rotates or removes env vars (plain or secret) with a rolling update |
| `telemetry_toggle` | Turns OpenTelemetry on or off for a stack (admin). Sampling is tail-based at the collector. Session replay and analytics will join this tool when they ship |

The server is **read-only by default**. A `read` key cannot even see the
mutating tools. With a `write` key, the controller still applies your role and
the org's ABAC policies to every call; a denied call comes back to the model
as a tool error.

### Claude Code

Local (stdio), using the CLI's stored login:

```sh
claude mcp add swarmy -- swarmy mcp            # tools match what your key allows
claude mcp add swarmy -- swarmy mcp --read-only
```

Remote (HTTP) with an API key:

```sh
claude mcp add --transport http swarmy https://swarm.example.com/mcp \
  --header "Authorization: Bearer swk_…"
```

Remote with OAuth (sign in through swarmy's own identity provider, with no key
to paste):

```sh
claude mcp add --transport http swarmy https://swarm.example.com/mcp \
  --client-id swarmy-mcp --callback-port 33418
```

Then run `/mcp` in Claude Code to authenticate. The OAuth flow works like this:

- The controller registers the public PKCE client `swarmy-mcp` on boot. Its
  redirect URIs are `http://localhost:33418/callback` and
  `http://127.0.0.1/callback` on any port.
- The token is issued for `https://swarm.example.com/mcp`, via the RFC 8707
  `resource` parameter that MCP clients send.
- Its scopes are `swarmy:read` or `swarmy:write`.
- Dynamic client registration stays closed.

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "swarmy": { "command": "swarmy", "args": ["mcp"] }
  }
}
```

or remote:

```json
{
  "mcpServers": {
    "swarmy": {
      "url": "https://swarm.example.com/mcp",
      "headers": { "Authorization": "Bearer swk_…" }
    }
  }
}
```

### How `/mcp` works

- **Transport.** The endpoint speaks stateless Streamable HTTP. It serves both
  the 2025 protocol and the 2026-07-28 protocol, built on
  `@modelcontextprotocol/server` 2.x.
- **Authentication.** Each request needs a bearer: an `swk_…` API key, or a
  JWT access token issued by swarmy's OIDC provider for `<controller>/mcp`.
  The token is verified against the provider's JWKS, in process.
- **Unauthenticated requests.** They get `401` with
  `WWW-Authenticate: Bearer resource_metadata=…`. Metadata lives at
  `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and names the
  authorization server `<controller>/api/auth`.
- **Tool calls.** They call the REST API in-process with the caller's own
  bearer. The REST API accepts the same OAuth tokens (audience
  `<controller>/api/v1`).

## REST endpoints behind the CLI

These are all in the OpenAPI spec at `/api/v1/docs`, under the Developer tag:

| Endpoint | What it does |
|---|---|
| `GET /me` | Who this credential acts as, and its scopes |
| `GET /services/{id}/env?reveal_secrets=true` | A service's env. Secrets are revealed only with the `secrets.read` scope and an ABAC permit, and every reveal is audited |
| `PATCH /services/{id}/env` | Merge-patches env with `set`, `secrets` and `unset`, then rolls out (`202`) |
| `GET /services/{id}/logs` | Recent log lines |
| `GET /services/{id}/logs/stream` | Follows logs as Server-Sent Events |
| `GET /deployments/{id}` | A deployment's status |
| `POST /apps/{repoId}/previews` | Creates a trial preview |
| `GET /stacks/{id}/telemetry` | Whether telemetry is on for a stack |
| `GET /stacks/{id}/errors` | Error tracking status and the DSN |
| `POST /stacks/{id}/errors/rotate-key` | Rotates the DSN key (admin) |
| `PUT /stacks/{id}/telemetry` | Turns telemetry on or off |

The device flow endpoints are public, as RFC 8628 requires:

| Endpoint | What it does |
|---|---|
| `POST /api/cli/device/code` | Starts a login and returns the device and user codes |
| `POST /api/cli/device/token` | Polled by the CLI until the login is approved |

Pending logins live only in controller memory and expire after 10 minutes.
