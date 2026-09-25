import { beforeAll, describe, expect, test } from 'bun:test';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-mesh-control-handover-0123456789';

const { encryptSecret } = await import('@swarmy/core/crypto');
const { currentPublicUrl, edgeServesMesh, effectiveTls, renderControlSpec } = await import('./mesh-control.service');
type M = Parameters<typeof renderControlSpec>[0];

let m: M;
beforeAll(() => {
  m = {
    cluster: 'lon',
    meshDomain: 'mesh.example.com',
    tls: { mode: 'edge', listen: '172.17.0.1:8081' },
    bootstrapTls: { mode: 'none', port: 8081 },
    authSecretEnc: encryptSecret('relay-secret-0123456789'),
    encryptionKeyEnc: encryptSecret('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='),
  };
});

const cfgOf = (spec: { configYaml: string }) => JSON.parse(spec.configYaml.split('\n').slice(1).join('\n')).server;

describe('TLS handover (QA-012)', () => {
  test('before: NetBird runs plain on :8081 and says so to peers', () => {
    expect(effectiveTls(m)).toEqual({ mode: 'none', port: 8081 });
    const c = cfgOf(renderControlSpec(m));
    expect(c.exposedAddress).toBe('http://mesh.example.com:8081');
    expect(c.listenAddress).toBe(':8081');
    expect(currentPublicUrl(m)).toBe('http://mesh.example.com:8081');
  });

  test('after: the edge config — https exposed, SAME :8081 listener, so pre-handover peers keep their management URL', () => {
    const after = { ...m, handedOverAt: 1 };
    const c = cfgOf(renderControlSpec(after));
    expect(c.exposedAddress).toBe('https://mesh.example.com:443');
    expect(c.auth.issuer).toBe('https://mesh.example.com/oauth2');
    // host part is ignored by the server (spike §11.2): it binds *:8081 either way
    expect(c.listenAddress.endsWith(':8081')).toBe(true);
    expect(currentPublicUrl(after)).toBe('https://mesh.example.com');
    // …and the config changed, so the agent restarts NetBird (the handover itself)
    expect(renderControlSpec(after).configYaml).not.toBe(renderControlSpec(m).configYaml);
  });

  test('no bootstrap (letsencrypt / none installs): no handover, final mode from the start', () => {
    const { bootstrapTls: _b, ...plain } = m;
    expect(effectiveTls(plain)).toEqual(m.tls);
  });

  test('edgeServesMesh: only a real answer from NetBird through the edge counts', async () => {
    const ok = (async () => new Response('{"setup_required":false}', { status: 200 })) as unknown as typeof fetch;
    const caddy502 = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    const caddyDefault = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const spy = (async (u: string) => (seen.push(String(u)), new Response('{"setup_required":false}'))) as unknown as typeof fetch;
    expect(await edgeServesMesh(m, ok)).toBe(true);
    expect(await edgeServesMesh(m, caddy502)).toBe(false);
    expect(await edgeServesMesh(m, caddyDefault)).toBe(false);
    expect(await edgeServesMesh(m, down)).toBe(false);
    await edgeServesMesh({ ...m, tls: { mode: 'edge', listen: 'x:8081', publicPort: 8444 } }, spy);
    expect(seen).toEqual(['https://mesh.example.com:8444/api/instance']);
  });
});


describe('mesh vhost upstream (QA-071: every edge, not just the control node)', () => {
  test('points at the control node mesh IP, keeping the listener port', async () => {
    const { meshControlUpstream } = await import('./mesh-control.service');
    expect(meshControlUpstream('172.17.0.1:8081', '100.106.243.149')).toBe('100.106.243.149:8081');
    expect(meshControlUpstream('172.17.0.1:9081', '100.106.243.149')).toBe('100.106.243.149:9081');
  });
  test('keeps the configured listener until a mesh IP is known (or it is not a mesh address)', async () => {
    const { meshControlUpstream } = await import('./mesh-control.service');
    expect(meshControlUpstream('172.17.0.1:8081', undefined)).toBe('172.17.0.1:8081');
    expect(meshControlUpstream('172.17.0.1:8081', '203.0.113.7')).toBe('172.17.0.1:8081');
  });
});
