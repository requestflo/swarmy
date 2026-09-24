import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fakeApi, serveFakeApi } from '@swarmy/devkit/testing';

const MAIN = path.resolve(import.meta.dir, '../src/main.ts');
const REPO = path.resolve(import.meta.dir, '../../..');

async function spawnMcp(url: string, extraArgs: string[] = []) {
  const transport = new StdioClientTransport({
    // SWARMY_CLI_BIN runs the same test against a compiled binary.
    command: process.env.SWARMY_CLI_BIN ?? process.execPath,
    args: [...(process.env.SWARMY_CLI_BIN ? [] : [MAIN]), 'mcp', ...extraArgs],
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SWARMY_API_KEY: 'swk_test', SWARMY_CONTROLLER: url },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('swarmy mcp over stdio', () => {
  const rw = fakeApi({ scopes: ['read', 'write'] });
  let srv: { url: string; stop: () => void };
  beforeAll(() => {
    srv = serveFakeApi(rw);
  });
  afterAll(() => srv.stop());

  test('round trip: initialize, list tools, call check_repo and list_apps', async () => {
    const client = await spawnMcp(srv.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['check_repo', 'list_apps', 'app_status', 'logs', 'env', 'explain_error', 'deploy', 'trial_deploy', 'telemetry_toggle']));

      const check = await client.callTool({ name: 'check_repo', arguments: { path: 'apps/cli' } });
      expect(check.isError).toBeFalsy();
      expect((check.structuredContent as { mode: string }).mode).toBe('detected');

      const apps = await client.callTool({ name: 'list_apps', arguments: {} });
      expect(JSON.stringify(apps.content)).toContain('acme/shop');
      expect(rw.calls.some((c) => c.path === '/me' && c.auth === 'Bearer swk_test')).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  test('--read-only hides mutating tools even for a write key', async () => {
    const client = await spawnMcp(srv.url, ['--read-only']);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('deploy');
      expect(names).toContain('app_status');
    } finally {
      await client.close();
    }
  }, 20_000);
});
