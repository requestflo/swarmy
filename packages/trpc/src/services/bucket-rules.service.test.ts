import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { buildCorsXml, parseCorsXml } from './bucket-cors-xml';
import { getBucketCors, setBucketCors } from './bucket-cors.service';
import { buildS3Script } from './bucket-s3-call';
import { STATUS_MARKER } from './buckets.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

const FAKE_BUCKET_ID = 'b'.repeat(64);

/**
 * A fake Garage: answers the admin one-shots (bucket info, key mint, allow)
 * and the presigned S3 one-shots (`?cors`, `?lifecycle`), recording each call.
 */
function fakeGarageS3(opts: { engineImage?: string | null; docs?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const audits: Array<{ action: string; metadata: unknown }> = [];
  const docs: Record<string, string> = { ...opts.docs };
  const grants = new Map<string, { read: boolean; write: boolean; owner: boolean }>();
  const v2 = (opts.engineImage ?? '').includes(':v2');
  const reply = (status: number, body: string) => ({ exitCode: 0, output: `${STATUS_MARKER}${status}\n${body}` });
  const hub = {
    isOnline: () => true,
    managerNode: () => 'mgr',
    liveInventory: () => ({ services: [], containers: [] }),
    dispatch: async (_node: string, cmd: string, payload: { env?: Record<string, string> }) => {
      if (cmd !== 'container.runOnce') return {};
      const env = payload.env ?? {};
      if (env.S3_URL) {
        const url = new URL(env.S3_URL);
        const sub = url.searchParams.has('cors') ? 'cors' : url.searchParams.has('lifecycle') ? 'lifecycle' : '?';
        calls.push(`S3 ${env.S3_METHOD} ${url.pathname}?${sub}`);
        if (env.S3_METHOD === 'PUT') docs[sub] = env.S3_BODY ?? '';
        if (env.S3_METHOD === 'DELETE') delete docs[sub];
        if (env.S3_METHOD !== 'GET') return reply(env.S3_METHOD === 'DELETE' ? 204 : 200, '');
        if (docs[sub] !== undefined) return reply(200, docs[sub]!);
        const none = sub === 'cors' ? 'NoSuchCORSConfiguration' : 'NoSuchLifecycleConfiguration';
        return v2 ? reply(404, `<Error><Code>${none}</Code></Error>`) : reply(204, '');
      }
      const url = new URL(env.GARAGE_URL!);
      // v1 paths (`/v1/key`, `/v1/bucket/allow`) or their v2 operations.
      const op = { '/v1/key': 'key', '/v2/CreateKey': 'key', '/v1/bucket/allow': 'allow', '/v2/AllowBucketKey': 'allow' }[url.pathname];
      calls.push(`${env.GARAGE_METHOD} ${op === 'allow' ? '/bucket/allow' : url.pathname}`);
      if (op === 'key') return reply(200, JSON.stringify({ accessKeyId: 'GKpresign', secretAccessKey: 'sekrit', name: 'swarmy-presign' }));
      if (op === 'allow') {
        const body = JSON.parse(env.GARAGE_BODY ?? '{}') as { accessKeyId: string; permissions: { read: boolean; write: boolean; owner: boolean } };
        const cur = grants.get(body.accessKeyId) ?? { read: false, write: false, owner: false };
        grants.set(body.accessKeyId, {
          read: cur.read || body.permissions.read,
          write: cur.write || body.permissions.write,
          owner: cur.owner || body.permissions.owner,
        });
        return reply(200, '{}');
      }
      const keys = [...grants].map(([accessKeyId, permissions]) => ({ accessKeyId, name: 'swarmy-presign', permissions }));
      return reply(200, JSON.stringify({ id: FAKE_BUCKET_ID, globalAliases: ['storefront-media'], keys }));
    },
  };
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      auditLog: {
        create: async ({ data }: { data: { action: string; metadata: unknown } }) => {
          audits.push({ action: data.action, metadata: data.metadata });
          return {};
        },
      },
    },
    hub,
  } as unknown as OrgContext;
  useMemoryKv(ctx.hub);
  seedKv(ctx.hub, 'org1', 'storage', 'org1', {
    driver: 'GARAGE',
    enabled: true,
    replicationFactor: 1,
    region: 'swarmy',
    memberNodeIds: ['mgr'],
    adminTokenRef: encryptSecret('gadm_fake'),
    accessKeyRef: null,
    secretKeyRef: null,
    layout: {},
    engineImage: opts.engineImage ?? null,
  });
  return { ctx, calls, audits, docs, grants };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e.message;
    throw e;
  }
  throw new Error('expected a refusal');
}

/** What Garage's serializer returns for two rules (element order as quick-xml writes it). */
const GARAGE_CORS = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><ID>swarmy-1</ID><MaxAgeSeconds>3600</MaxAgeSeconds><AllowedOrigin>https://shop.northwind.dev</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule><CORSRule><AllowedOrigin>http://localhost:3000</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;

describe('CORS documents (golden)', () => {
  it('writes one rule per origin, in Garage struct order', () => {
    expect(buildCorsXml({ origins: ['https://a.dev', 'https://b.dev'], methods: ['GET', 'PUT'], maxAgeSeconds: 600 })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<CORSRule><ID>swarmy-1</ID><MaxAgeSeconds>600</MaxAgeSeconds><AllowedOrigin>https://a.dev</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule>' +
        '<CORSRule><ID>swarmy-2</ID><MaxAgeSeconds>600</MaxAgeSeconds><AllowedOrigin>https://b.dev</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule>' +
        '</CORSConfiguration>',
    );
  });

  it('omits MaxAgeSeconds when the preflight is not cached, and parses back', () => {
    const xml = buildCorsXml({ origins: ['*'], methods: ['GET'], maxAgeSeconds: null });
    expect(xml).not.toContain('MaxAgeSeconds');
    expect(parseCorsXml(xml)).toEqual([{ origins: ['*'], methods: ['GET'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: null }]);
  });

  it('reads what Garage returns, whatever the element order', () => {
    const rules = parseCorsXml(GARAGE_CORS);
    expect(rules.map((r) => r.origins[0])).toEqual(['https://shop.northwind.dev', 'http://localhost:3000']);
    expect(rules.every((r) => r.maxAgeSeconds === 3600)).toBe(true);
  });

  it('the one-shot carries the presigned URL and body as env, never argv', () => {
    const script = buildS3Script();
    expect(script).toContain('"$S3_URL"');
    expect(script).toContain('--data-binary "$S3_BODY"');
    expect(script).not.toMatch(/X-Amz-Signature|sekrit/);
  });
});

describe('buckets.getCors / setCors against a fake Garage', () => {
  it('no rules: v1 answers 204, v2 answers 404 NoSuchCORSConfiguration — both read as none', async () => {
    for (const engineImage of [null, 'dxflrs/garage:v2.4.1']) {
      const g = fakeGarageS3({ engineImage });
      const v = await getBucketCors(g.ctx, FAKE_BUCKET_ID);
      expect(v).toMatchObject({ bucket: 'storefront-media', origins: [], rules: [], wildcards: engineImage !== null });
    }
  });

  it('the signing key is granted owner first (Garage gates ?cors on owner), once', async () => {
    const g = fakeGarageS3({ docs: { cors: GARAGE_CORS } });
    const v = await getBucketCors(g.ctx, FAKE_BUCKET_ID);
    expect(v.origins).toEqual(['https://shop.northwind.dev', 'http://localhost:3000']);
    expect(g.grants.get('GKpresign')).toEqual({ read: true, write: true, owner: true });
    expect(g.calls.filter((c) => c.endsWith('/bucket/allow'))).toHaveLength(1);
    await getBucketCors(g.ctx, FAKE_BUCKET_ID);
    expect(g.calls.filter((c) => c.endsWith('/bucket/allow'))).toHaveLength(1);
    expect(g.calls).toContain('S3 GET /storefront-media?cors');
  });

  it('set: normalises, writes one rule per origin, audits from → to', async () => {
    const g = fakeGarageS3({ engineImage: 'dxflrs/garage:v2.4.1' });
    const v = await setBucketCors(g.ctx, {
      bucketId: FAKE_BUCKET_ID,
      origins: ['https://Shop.Northwind.dev/', 'https://*.northwind.dev', 'https://shop.northwind.dev'],
      methods: ['GET', 'HEAD', 'PUT'],
      maxAgeSeconds: 3600,
    });
    expect(v.origins).toEqual(['https://shop.northwind.dev', 'https://*.northwind.dev']);
    expect(parseCorsXml(g.docs.cors!)).toHaveLength(2);
    expect(g.audits.at(-1)).toEqual({
      action: 'buckets.setCors',
      metadata: {
        bucket: 'storefront-media',
        from: { origins: [], methods: [], maxAgeSeconds: null },
        to: { origins: ['https://shop.northwind.dev', 'https://*.northwind.dev'], methods: ['GET', 'HEAD', 'PUT'], maxAgeSeconds: 3600 },
      },
    });
  });

  it('no origins removes the rules (DELETE ?cors)', async () => {
    const g = fakeGarageS3({ docs: { cors: GARAGE_CORS } });
    const v = await setBucketCors(g.ctx, { bucketId: FAKE_BUCKET_ID, origins: [], methods: ['GET'], maxAgeSeconds: null });
    expect(v.rules).toEqual([]);
    expect(g.calls).toContain('S3 DELETE /storefront-media?cors');
    expect(g.docs.cors).toBeUndefined();
  });

  it('refuses a wildcard a v1 engine cannot match, and a policy with no methods', async () => {
    const g = fakeGarageS3();
    const wild = { bucketId: FAKE_BUCKET_ID, origins: ['https://*.northwind.dev'], methods: ['GET' as const], maxAgeSeconds: 60 };
    expect(await refusal(setBucketCors(g.ctx, wild))).toMatch(/Garage v1/);
    expect(await refusal(setBucketCors(g.ctx, { ...wild, origins: ['https://a.dev'], methods: [] }))).toMatch(/at least one method/);
    expect(g.calls.some((c) => c.startsWith('S3 PUT'))).toBe(false);
  });
});
