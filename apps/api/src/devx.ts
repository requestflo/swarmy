/**
 * The developer-platform front doors on the controller (epic "developer
 * platform" §4):
 *
 *   POST /api/cli/device/code     start `swarmy login` (RFC 8628 device grant)
 *   POST /api/cli/device/token    the CLI's poll → an `swk_…` API key
 *   GET  /install/cli.sh          `curl -fsSL <controller>/install/cli.sh | sh`
 *   GET  /install/cli/manifest.json, /install/cli/<platform>[.sha256]
 *   ALL  /mcp                     the MCP server (Streamable HTTP)
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata
 *
 * /mcp authenticates every request with a bearer — an API key or an OAuth
 * access token issued by swarmy's own OIDC provider for `<base>/mcp` — and
 * then runs the same tools as `swarmy mcp`, whose SDK client calls the REST
 * API IN-PROCESS with that same bearer. So the MCP endpoint can never do more
 * than the REST API would let that credential do (scope, role, ABAC).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createSwarmyMcpServer, SwarmyClient } from '@swarmy/devkit';
import { oidcIssuer, SWARMY_API_SCOPES } from '@swarmy/auth';
import type { ResolvedApiKeyContext } from '@swarmy/trpc';
import { pollDeviceAuthorization, startDeviceAuthorization } from '@swarmy/trpc/devx';

export interface DevxDeps {
  /** The controller app's own fetch, for in-process REST calls. */
  appFetch: (req: Request) => Response | Promise<Response>;
  /** The bearer seam (`resolveOrgContextFromBearer`). */
  resolveBearer: (presented: string) => Promise<ResolvedApiKeyContext | null>;
  env?: Record<string, string | undefined>;
}

const INTERNAL_ORIGIN = 'http://swarmy.internal';

function publicBase(env: Record<string, string | undefined>): string {
  return (env.CONTROLLER_PUBLIC_URL ?? env.BETTER_AUTH_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
}

function dashboardBase(env: Record<string, string | undefined>): string {
  return (env.DASHBOARD_URL || publicBase(env)).replace(/\/+$/, '');
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const b = await req.json().catch(() => ({}));
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  }
  const form = await req.formData().catch(() => null);
  const out: Record<string, unknown> = {};
  form?.forEach((v, k) => {
    out[k] = typeof v === 'string' ? v : '';
  });
  return out;
}

// ── CLI binaries ─────────────────────────────────────────────────────────────

export interface CliReleaseManifest {
  version: string;
  commit?: string;
  platforms: Record<string, { sha256: string; size: number }>;
}

export const CLI_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;

export function cliBinDir(env: Record<string, string | undefined> = process.env): string {
  if (env.SWARMY_CLI_BIN_DIR) return env.SWARMY_CLI_BIN_DIR;
  return path.resolve(import.meta.dir, '../../cli/dist-bin');
}

export function cliRelease(env: Record<string, string | undefined> = process.env): CliReleaseManifest | null {
  try {
    const m = JSON.parse(readFileSync(path.join(cliBinDir(env), 'manifest.json'), 'utf8')) as CliReleaseManifest;
    return m && typeof m.version === 'string' && m.platforms ? m : null;
  } catch {
    return null;
  }
}

/** The installer script: detect the platform, download, verify sha256, install. */
export function renderCliInstaller(base: string): string {
  return `#!/bin/sh
# swarmy CLI installer — served by your controller (${base}).
#   curl -fsSL ${base}/install/cli.sh | sh
# Installs to $SWARMY_INSTALL_DIR, else ~/.local/bin (or /usr/local/bin as root).
set -eu
BASE=${JSON.stringify(base)}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in darwin|linux) ;; *) echo "swarmy: unsupported OS $os" >&2; exit 1 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "swarmy: unsupported CPU $arch" >&2; exit 1 ;; esac
platform="$os-$arch"
if [ -n "\${SWARMY_INSTALL_DIR:-}" ]; then dir="$SWARMY_INSTALL_DIR"
elif [ "$(id -u)" = 0 ]; then dir=/usr/local/bin
else dir="$HOME/.local/bin"; fi
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "swarmy: downloading $platform from $BASE" >&2
curl -fsSL "$BASE/install/cli/$platform" -o "$tmp/swarmy"
want=$(curl -fsSL "$BASE/install/cli/$platform.sha256" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/swarmy" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp/swarmy" | cut -d' ' -f1); fi
if [ "$want" != "$got" ]; then echo "swarmy: checksum mismatch (want $want, got $got)" >&2; exit 1; fi
chmod 0755 "$tmp/swarmy"
mv "$tmp/swarmy" "$dir/swarmy"
echo "swarmy: installed $dir/swarmy" >&2
case ":$PATH:" in *":$dir:"*) ;; *) echo "swarmy: add $dir to your PATH" >&2 ;; esac
echo "Next: swarmy login --controller $BASE" >&2
`;
}

// ── the app ──────────────────────────────────────────────────────────────────

export function createDevxApp(deps: DevxDeps): Hono {
  const env = deps.env ?? process.env;
  const app = new Hono();

  // `swarmy login` — start.
  app.post('/api/cli/device/code', async (c) => {
    const body = await readBody(c.req.raw);
    const scopeRaw = body.scope ?? body.scopes;
    const scopes = Array.isArray(scopeRaw)
      ? scopeRaw.map(String)
      : typeof scopeRaw === 'string'
        ? scopeRaw.split(/[\s,]+/).filter(Boolean)
        : [];
    try {
      const d = startDeviceAuthorization({
        ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
        ...(typeof body.hostname === 'string' ? { hostname: body.hostname } : {}),
        scopes,
      });
      const verify = `${dashboardBase(env)}/device`;
      c.header('cache-control', 'no-store');
      return c.json({
        device_code: d.deviceCode,
        user_code: d.userCode,
        verification_uri: verify,
        verification_uri_complete: `${verify}?code=${encodeURIComponent(d.userCode)}`,
        expires_in: d.expiresIn,
        interval: d.interval,
      });
    } catch (e) {
      return c.json({ error: 'slow_down', error_description: e instanceof Error ? e.message : String(e) }, 429);
    }
  });

  // `swarmy login` — poll (RFC 8628 §3.4/3.5 error codes).
  app.post('/api/cli/device/token', async (c) => {
    const body = await readBody(c.req.raw);
    c.header('cache-control', 'no-store');
    if (body.grant_type !== undefined && body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (typeof body.device_code !== 'string' || !body.device_code) return c.json({ error: 'invalid_request' }, 400);
    const r = pollDeviceAuthorization(body.device_code);
    if (r.status === 'approved') return c.json({ access_token: r.key, token_type: 'Bearer', scope: r.scopes.join(' ') });
    return c.json({ error: r.status }, 400);
  });

  // CLI binaries, self-hosted like the agent's (/install/bin).
  app.get('/install/cli.sh', (c) =>
    c.body(renderCliInstaller(publicBase(env)), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    }),
  );
  app.get('/install/cli/manifest.json', (c) => {
    const m = cliRelease(env);
    return m ? c.json(m, 200, { 'cache-control': 'no-store' }) : c.text('no CLI binaries built on this controller', 404);
  });
  app.get('/install/cli/:file{[a-z0-9.-]+}', (c) => {
    const file = c.req.param('file');
    const checksum = file.endsWith('.sha256');
    const platform = checksum ? file.slice(0, -'.sha256'.length) : file;
    const meta = cliRelease(env)?.platforms[platform];
    if (!meta || !(CLI_PLATFORMS as readonly string[]).includes(platform)) return c.text(`no CLI binary for ${platform}`, 404);
    if (checksum) return c.text(`${meta.sha256}  swarmy-${platform}\n`, 200, { 'cache-control': 'no-store' });
    const p = path.join(cliBinDir(env), `swarmy-${platform}`);
    if (!existsSync(p)) return c.text(`no CLI binary for ${platform}`, 404);
    return new Response(Bun.file(p), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="swarmy-${platform}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // RFC 9728: where MCP clients learn which authorization server to use.
  const resourceMetadata = () => ({
    resource: `${publicBase(env)}/mcp`,
    resource_name: 'swarmy',
    authorization_servers: [oidcIssuer(env)],
    scopes_supported: [...SWARMY_API_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${publicBase(env)}/api/v1/docs`,
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata()));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata()));

  // The MCP server, one fresh instance per request (stateless Streamable HTTP).
  const mcp = createMcpHandler(({ authInfo }) => {
    const token = authInfo?.token ?? '';
    const client = new SwarmyClient({
      endpoint: INTERNAL_ORIGIN,
      apiKey: token,
      fetch: async (url, init) => deps.appFetch(new Request(url, init)),
    });
    return createSwarmyMcpServer({
      client,
      scopes: authInfo?.scopes ?? [],
      transport: 'http',
      controllerUrl: publicBase(env),
    });
  });

  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const resolved = header ? await deps.resolveBearer(header).catch(() => null) : null;
    if (!resolved) {
      const meta = `${publicBase(env)}/.well-known/oauth-protected-resource/mcp`;
      return c.json({ error: 'invalid_token', error_description: 'swarmy API key or OAuth access token required' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${meta}", scope="swarmy:read"${header ? ', error="invalid_token"' : ''}`,
      });
    }
    const token = header.replace(/^(?:Bearer|Token)\s+/i, '').trim();
    return mcp.fetch(c.req.raw, {
      authInfo: {
        token,
        clientId: resolved.apiKey.id,
        scopes: resolved.apiKey.scopes,
        extra: { orgId: resolved.ctx.activeOrgId, userId: resolved.ctx.user.id },
      },
    });
  });

  return app;
}
