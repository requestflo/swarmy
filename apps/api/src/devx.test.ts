import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ResolvedApiKeyContext } from '@swarmy/trpc';
import { fakeApi } from '@swarmy/devkit/testing';
import { createDevxApp, renderCliInstaller } from './devx';

const env = { CONTROLLER_PUBLIC_URL: 'https://ctl.example', BETTER_AUTH_URL: 'https://ctl.example', DASHBOARD_URL: '' };

function principal(scopes: Array<'read' | 'write'>): ResolvedApiKeyContext {
  return {
    ctx: { activeOrgId: 'org_1', user: { id: 'u1' } } as ResolvedApiKeyContext['ctx'],
    apiKey: { id: 'key_1', scopes, kind: 'api_key' },
  };
}

function build(scopes: Array<'read' | 'write'> = ['read'], extraEnv: Record<string, string> = {}) {
  const api = fakeApi({ scopes });
  const app = createDevxApp({
    env: { ...env, ...extraEnv },
    appFetch: (req) => api.fetch(req),
    resolveBearer: async (h) => (h === 'Bearer swk_test' ? principal(scopes) : null),
  });
  return { app, api };
}

describe('device login endpoints', () => {
  test('start then poll: pending, with RFC 8628 shapes', async () => {
    const { app } = build();
    const start = await app.request('/api/cli/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'swarmy CLI', hostname: 'box', scope: 'read write' }),
    });
    expect(start.status).toBe(200);
    const s = (await start.json()) as Record<string, string | number>;
    expect(s.verification_uri).toBe('https://ctl.example/device');
    expect(s.verification_uri_complete).toBe(`https://ctl.example/device?code=${s.user_code}`);
    expect(s.interval).toBe(5);
    const poll = await app.request('/api/cli/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${s.device_code}`,
    });
    expect(poll.status).toBe(400);
    expect(await poll.json()).toEqual({ error: 'authorization_pending' });
    const bad = await app.request('/api/cli/device/token', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } });
    expect(await bad.json()).toEqual({ error: 'invalid_request' });
  });
});

describe('CLI binaries', () => {
  test('manifest, binary and checksum from the bin dir; installer pins the controller', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cli-bin-'));
    await writeFile(path.join(dir, 'swarmy-linux-x64'), 'BIN');
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.2.3', platforms: { 'linux-x64': { sha256: 'ab'.repeat(32), size: 3 } } }));
    const { app } = build(['read'], { SWARMY_CLI_BIN_DIR: dir });
    expect(((await (await app.request('/install/cli/manifest.json')).json()) as { version: string }).version).toBe('1.2.3');
    expect(await (await app.request('/install/cli/linux-x64')).text()).toBe('BIN');
    expect(await (await app.request('/install/cli/linux-x64.sha256')).text()).toBe(`${'ab'.repeat(32)}  swarmy-linux-x64\n`);
    expect((await app.request('/install/cli/windows-x64')).status).toBe(404);
    expect(renderCliInstaller('https://ctl.example')).toContain('BASE="https://ctl.example"');
  });
});

describe('/mcp', () => {
  test('unauthenticated requests get a 401 pointing at the resource metadata', async () => {
    const { app } = build();
    const r = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://ctl.example/.well-known/oauth-protected-resource/mcp", scope="swarmy:read"',
    );
    const meta = (await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      resource: 'https://ctl.example/mcp',
      authorization_servers: ['https://ctl.example/api/auth'],
      scopes_supported: ['swarmy:read', 'swarmy:write'],
    });
  });

  test('an authenticated client lists and calls tools; REST is called with the same bearer', async () => {
    const { app, api } = build(['read']);
    const transport = new StreamableHTTPClientTransport(new URL('https://ctl.example/mcp'), {
      fetch: (async (url: string | URL, init?: RequestInit) => app.request(String(url), init)) as never,
      requestInit: { headers: { Authorization: 'Bearer swk_test' } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_apps');
    expect(names).not.toContain('deploy');
    const r = await client.callTool({ name: 'list_apps', arguments: {} });
    expect(JSON.stringify(r.content)).toContain('acme/shop');
    expect(api.calls.find((c) => c.path === '/apps')?.auth).toBe('Bearer swk_test');
    await client.close();
  });
});
