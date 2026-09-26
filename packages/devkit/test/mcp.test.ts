import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createSwarmyMcpServer, MUTATING_TOOLS, READ_TOOLS } from '../src/mcp';
import { SwarmyClient } from '../src/sdk';
import { explainError } from '../src/explain';
import { fakeApi } from '../src/testing/fake-api';

async function connect(scopes: string[], extra: { readOnly?: boolean; transport?: 'stdio' | 'http' } = {}) {
  const api = fakeApi({ scopes });
  const client = new SwarmyClient({
    endpoint: 'http://ctl.test',
    apiKey: 'swk_test',
    fetch: (input, init) => api.fetch(new Request(input, init)),
  });
  const server = createSwarmyMcpServer({ client, scopes, transport: extra.transport ?? 'stdio', readOnly: extra.readOnly ?? false });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(clientEnd);
  return { mcp, api };
}

const text = (r: { content?: unknown }) =>
  ((r.content as Array<{ type: string; text?: string }>) ?? []).map((c) => c.text ?? '').join('\n');

describe('MCP tool schemas', () => {
  test('a read-only key sees only read tools, each read-only annotated with a described schema', async () => {
    const { mcp } = await connect(['read']);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    const logs = tools.find((t) => t.name === 'logs')!;
    expect(logs.inputSchema.required).toEqual(['service']);
    expect((logs.inputSchema.properties as Record<string, { maximum?: number }>).tail!.maximum).toBe(1000);
  });

  test('a write key gets the mutating tools; readOnly overrides it', async () => {
    const rw = await connect(['read', 'write']);
    const names = (await rw.mcp.listTools()).tools.map((t) => t.name);
    for (const n of MUTATING_TOOLS) expect(names).toContain(n);
    const deploy = (await rw.mcp.listTools()).tools.find((t) => t.name === 'deploy')!;
    expect(deploy.annotations?.readOnlyHint).toBe(false);
    expect(deploy.inputSchema.required).toEqual(['app']);

    const ro = await connect(['read', 'write'], { readOnly: true });
    expect((await ro.mcp.listTools()).tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });
});

describe('MCP tools over the REST SDK', () => {
  test('remove_stack: typed confirm required; data kept by default, deleted only with delete_data (QA-078)', async () => {
    const { mcp, api } = await connect(['read', 'write']);
    const tool = (await mcp.listTools()).tools.find((t) => t.name === 'remove_stack')!;
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(['confirm']);

    const wrong = await mcp.callTool({ name: 'remove_stack', arguments: { app: 'shop', confirm: 'yes' } });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain('confirm must be the stack name "shop"');
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);

    const kept = await mcp.callTool({ name: 'remove_stack', arguments: { app: 'shop', confirm: 'shop' } });
    expect(text(kept)).toContain('Its data is kept');
    expect(api.calls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe('/stacks/stk_1');

    const gone = await mcp.callTool({ name: 'remove_stack', arguments: { stack: 'shop', delete_data: true, confirm: 'shop' } });
    expect(text(gone)).toContain('Removed shop and its data');
    expect(api.calls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe('/stacks/stk_1?delete_data=true');
  });

  test('list_apps and app_status', async () => {
    const { mcp } = await connect(['read']);
    const apps = await mcp.callTool({ name: 'list_apps', arguments: {} });
    expect(text(apps)).toContain('"app": "shop"');
    const st = await mcp.callTool({ name: 'app_status', arguments: { app: 'shop' } });
    expect(st.isError).toBeFalsy();
    const sc = st.structuredContent as { stack: string; services: Array<{ name: string; replicas: string; last_error: string | null }> };
    expect(sc.stack).toBe('shop');
    expect(sc.services.find((s) => s.name === 'shop_web')).toMatchObject({ replicas: '1/2', last_error: expect.stringContaining('OOMKilled') });
  });

  test('logs resolves a short name within an app; env withholds secrets', async () => {
    const { mcp, api } = await connect(['read']);
    const logs = await mcp.callTool({ name: 'logs', arguments: { service: 'web', app: 'shop', tail: 50 } });
    expect(text(logs)).toContain('heap out of memory');
    expect(api.calls.some((c) => c.path.startsWith('/services/svc_web/logs?tail=50'))).toBe(true);
    const env = await mcp.callTool({ name: 'env', arguments: { service: 'shop_web' } });
    expect(text(env)).toContain('NODE_ENV=production');
    expect(text(env)).toContain('STRIPE_KEY=<secret, env>');
    expect(api.calls.every((c) => !c.path.includes('reveal_secrets'))).toBe(true);
  });

  test('explain_error reads a service’s last error and logs', async () => {
    const { mcp } = await connect(['read']);
    const r = await mcp.callTool({ name: 'explain_error', arguments: { service: 'web', app: 'shop' } });
    expect(text(r)).toContain('Killed for using too much memory');
  });

  test('check_repo over HTTP needs files; with files it validates', async () => {
    const { mcp } = await connect(['read'], { transport: 'http' });
    const none = await mcp.callTool({ name: 'check_repo', arguments: {} });
    expect(none.isError).toBe(true);
    const r = await mcp.callTool({
      name: 'check_repo',
      arguments: { files: { 'swarmy.yaml': 'version: 1\napp: x\nservices:\n  web:\n    image: nginx:1.27\n    port: 80\n' } },
    });
    expect((r.structuredContent as { ok: boolean; mode: string }).ok).toBe(true);
  });

  test('mutating tools call the write endpoints', async () => {
    const { mcp, api } = await connect(['read', 'write']);
    const d = await mcp.callTool({ name: 'deploy', arguments: { app: 'acme/shop', branch: 'main' } });
    expect(d.isError).toBeFalsy();
    expect(api.calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/apps/repo_1/deploy', body: { branch: 'main' } });
    const e = await mcp.callTool({ name: 'env_set', arguments: { service: 'web', app: 'shop', set: { LOG_LEVEL: 'debug' }, unset: ['OLD'] } });
    expect(text(e)).toContain('changed LOG_LEVEL, OLD');
    const t = await mcp.callTool({ name: 'telemetry_toggle', arguments: { app: 'shop', enabled: true } });
    expect(text(t)).toContain('Telemetry on for shop');
    const p = await mcp.callTool({ name: 'trial_deploy', arguments: { app: 'shop', branch: 'feat/x' } });
    expect(text(p)).toContain('https://pr-900001.preview.acme.test');
  });

  test('API errors surface as tool errors, not crashes', async () => {
    const { mcp } = await connect(['read']);
    const r = await mcp.callTool({ name: 'app_status', arguments: { app: 'nope' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no app "nope"');
  });
});

describe('explainError', () => {
  test('matches specific causes and skips the generic crash', () => {
    const ids = explainError('task: non-zero exit (137)\nOOMKilled').map((e) => e.id);
    expect(ids).toContain('oom-killed');
    expect(ids).not.toContain('crash');
  });
  test('pull auth, arch and health', () => {
    expect(explainError('Error: pull access denied for acme/x')[0]!.id).toBe('image-auth');
    expect(explainError('exec /app/server: exec format error')[0]!.id).toBe('exec-format');
    expect(explainError('container is unhealthy').map((e) => e.id)).toContain('unhealthy');
    expect(explainError('all good')).toEqual([]);
  });
});
