import { beforeEach, describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { NATIVE_TARGET_NAME } from './backups.repo';
import {
  _recentMintsForTest,
  attachKeyName,
  createUserKey,
  deleteKey,
  gcPlatformKeysWith,
  listKeys,
  PRESIGN_KEY_NAME,
  retireSupersededSystemKeys,
  rotateAccessKey,
  STATUS_MARKER,
} from './buckets.service';
import { CONTROL_KEY_NAME } from './controllerStore.service';
import { EDGE_CERTS_KEY_NAME } from './ingress-certs';
import { meshLitestreamKeyName } from './mesh-control.service';
import {
  PLATFORM_KEY_GRACE_MS,
  planPlatformKeyGc,
  platformKeyPurpose,
  reservedKeyNameReason,
} from './platform-keys';
import { RUM_S3_KEY_NAME } from './rum/rum-store';
import { seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

/** QA-081: platform-owned S3 keys are marked, deduplicated, and can't be deleted by a person. */

describe('platformKeyPurpose — the name is the mark', () => {
  it('recognises every consumer’s key name (pinned to the consumer constants)', () => {
    for (const name of [
      PRESIGN_KEY_NAME,
      CONTROL_KEY_NAME,
      'swarmy-build-logs',
      RUM_S3_KEY_NAME,
      EDGE_CERTS_KEY_NAME,
      'swarmy-edge-certs-purge',
      meshLitestreamKeyName('swarmy'),
      `${NATIVE_TARGET_NAME}-restic`,
    ]) {
      expect(platformKeyPurpose(name)).not.toBeNull();
    }
  });

  it('user keys and attach keys are not platform keys', () => {
    expect(platformKeyPurpose('ci-artifacts')).toBeNull();
    expect(platformKeyPurpose(attachKeyName('api', 'uploads'))).toBeNull();
    expect(platformKeyPurpose('swarmy-mesh-litestream-')).toBeNull();
    expect(platformKeyPurpose('')).toBeNull();
  });

  it('reserves the swarmy- prefix for new user keys', () => {
    expect(reservedKeyNameReason('swarmy-edge-certs')).toMatch(/reserved/);
    expect(reservedKeyNameReason('Swarmy-mine')).toMatch(/reserved/);
    expect(reservedKeyNameReason('ci-artifacts')).toBeNull();
  });
});

describe('planPlatformKeyGc', () => {
  const now = 10 * 60 * 60_000;
  const old = now - 2 * PLATFORM_KEY_GRACE_MS;
  const keys = [
    { id: 'GK1', name: 'swarmy-mesh-litestream-swarmy', createdAt: old },
    { id: 'GK2', name: 'swarmy-mesh-litestream-swarmy', createdAt: old },
    { id: 'GK3', name: 'swarmy-mesh-litestream-swarmy', createdAt: old },
    { id: 'GKe', name: 'swarmy-edge-certs' },
    { id: 'GKu', name: 'ci-artifacts', createdAt: old },
  ];

  it('keeps the held key per purpose and reaps the pile-up', () => {
    const gone = planPlatformKeyGc(
      keys,
      { 'mesh-litestream': ['GK2'], 'edge-certs': ['GKe'] },
      new Map(),
      now,
    );
    expect(gone.map((k) => k.id).sort()).toEqual(['GK1', 'GK3']);
  });

  it('unknown in-use (null / missing) is never unused', () => {
    expect(planPlatformKeyGc(keys, { 'mesh-litestream': null }, new Map(), now)).toEqual([]);
    expect(planPlatformKeyGc(keys, {}, new Map(), now)).toEqual([]);
  });

  it('never touches user keys, even when every purpose is known', () => {
    const gone = planPlatformKeyGc(
      keys,
      { 'mesh-litestream': [], 'edge-certs': [] },
      new Map(),
      now,
    );
    expect(gone.map((k) => k.id)).not.toContain('GKu');
  });

  it('a key minted inside the grace window is left alone (it may not be persisted yet)', () => {
    const recent = new Map([['GK1', now - 1000]]);
    const fresh = [
      ...keys,
      { id: 'GK4', name: 'swarmy-mesh-litestream-swarmy', createdAt: now - 1000 },
    ];
    const gone = planPlatformKeyGc(fresh, { 'mesh-litestream': ['GK2'] }, recent, now).map(
      (k) => k.id,
    );
    expect(gone).toEqual(['GK3']);
  });
});

// ── the API against a fake Garage ────────────────────────────────────────────

interface FakeKey {
  id: string;
  name: string;
}

function fakeGarage(initial: FakeKey[]) {
  const keys = new Map(initial.map((k) => [k.id, { ...k }] as const));
  const calls: string[] = [];
  let seq = 0;
  const hub = {
    isOnline: () => true,
    managerNode: () => 'mgr',
    liveInventory: () => ({ services: [], containers: [] }),
    dispatch: async (_node: string, cmd: string, payload: { env?: Record<string, string> }) => {
      if (cmd !== 'container.runOnce') return {};
      const env = payload.env ?? {};
      const url = new URL(env.GARAGE_URL!);
      const method = env.GARAGE_METHOD!;
      const route = `${method} ${url.pathname}`;
      calls.push(`${route}${url.search}`);
      const reply = (status: number, body: unknown) => ({
        exitCode: 0,
        output: `${STATUS_MARKER}${status}\n${JSON.stringify(body)}`,
      });
      const id = url.searchParams.get('id') ?? '';
      if (route === 'GET /v1/key' && url.searchParams.has('list')) {
        return reply(
          200,
          [...keys.values()].map((k) => ({ id: k.id, name: k.name })),
        );
      }
      if (route === 'GET /v1/key') {
        const k = keys.get(id);
        return k
          ? reply(200, { accessKeyId: k.id, name: k.name, buckets: [] })
          : reply(404, { message: 'no such key' });
      }
      if (route === 'DELETE /v1/key') {
        keys.delete(id);
        return reply(200, {});
      }
      if (route === 'POST /v1/key') {
        const name = (JSON.parse(env.GARAGE_BODY ?? '{}') as { name: string }).name;
        const k = { id: `GKnew${++seq}`, name };
        keys.set(k.id, k);
        return reply(200, { accessKeyId: k.id, secretAccessKey: 'sekrit', name });
      }
      return reply(404, { message: `unhandled ${route}` });
    },
  };
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async () => ({}) } },
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
    engineImage: null,
  });
  return { ctx, keys, calls };
}

async function refusal(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('buckets API — platform keys', () => {
  beforeEach(() => _recentMintsForTest().clear());

  it('the parser the fake speaks matches the real one', async () => {
    const { ctx } = fakeGarage([{ id: 'GKa', name: 'ci' }]);
    expect((await listKeys(ctx)).keys).toEqual([
      { id: 'GKa', name: 'ci', platform: false, usedBy: null },
    ]);
  });

  it('listKeys marks platform keys with what uses them', async () => {
    const { ctx } = fakeGarage([
      { id: 'GKe', name: 'swarmy-edge-certs' },
      { id: 'GKr', name: 'swarmy-object-storage-restic' },
      { id: 'GKu', name: 'laptop' },
    ]);
    const byId = Object.fromEntries((await listKeys(ctx)).keys.map((k) => [k.id, k] as const));
    expect(byId.GKe).toMatchObject({ platform: true, usedBy: 'Edge TLS certificate sync' });
    expect(byId.GKr?.platform).toBe(true);
    expect(byId.GKu).toMatchObject({ platform: false, usedBy: null });
  });

  it('deleteKey refuses a platform key with FORBIDDEN and leaves it in Garage', async () => {
    const { ctx, keys, calls } = fakeGarage([{ id: 'GKe', name: 'swarmy-edge-certs' }]);
    const e = await refusal(deleteKey(ctx, 'GKe'));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toMatch(/Edge TLS certificate sync/);
    expect(keys.has('GKe')).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('rotateAccessKey refuses a platform key with FORBIDDEN (it would orphan the consumer)', async () => {
    const { ctx, keys } = fakeGarage([{ id: 'GKr', name: 'swarmy-object-storage-restic' }]);
    const e = await refusal(rotateAccessKey(ctx, 'GKr'));
    expect(e.code).toBe('FORBIDDEN');
    expect([...keys.keys()]).toEqual(['GKr']);
  });

  it('deleteKey still deletes a user key', async () => {
    const { ctx, keys } = fakeGarage([{ id: 'GKu', name: 'laptop' }]);
    await deleteKey(ctx, 'GKu');
    expect(keys.has('GKu')).toBe(false);
  });

  it('a person cannot mint a key under the reserved prefix', async () => {
    const { ctx, keys } = fakeGarage([]);
    const e = await refusal(createUserKey(ctx, 'swarmy-edge-certs'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(keys.size).toBe(0);
    await createUserKey(ctx, 'ci');
    expect(keys.size).toBe(1);
  });

  it('retireSupersededSystemKeys: one key per purpose once the new one is persisted', async () => {
    const { ctx, keys } = fakeGarage([
      { id: 'GK1', name: 'swarmy-mesh-litestream-swarmy' },
      { id: 'GK2', name: 'swarmy-mesh-litestream-swarmy' },
      { id: 'GK3', name: 'swarmy-mesh-litestream-swarmy' },
      { id: 'GKo', name: 'swarmy-mesh-litestream-other' },
      { id: 'GKu', name: 'laptop' },
    ]);
    const removed = await retireSupersededSystemKeys(ctx, 'swarmy-mesh-litestream-swarmy', 'GK3');
    expect(removed.sort()).toEqual(['GK1', 'GK2']);
    expect([...keys.keys()].sort()).toEqual(['GK3', 'GKo', 'GKu']);
  });

  it('retire never takes a concurrent caller’s fresh mint', async () => {
    const { ctx, keys } = fakeGarage([{ id: 'GK1', name: 'swarmy-rum' }]);
    _recentMintsForTest().set('GK1', Date.now());
    await retireSupersededSystemKeys(ctx, 'swarmy-rum', 'GK9');
    expect(keys.has('GK1')).toBe(true);
  });

  it('gcPlatformKeysWith reaps unheld platform keys and nothing else', async () => {
    const { ctx, keys } = fakeGarage([
      { id: 'GKc1', name: 'swarmy-control-litestream' },
      { id: 'GKc2', name: 'swarmy-control-litestream' },
      { id: 'GKp', name: 'swarmy-edge-certs-purge' },
      { id: 'GKe', name: 'swarmy-edge-certs' },
      { id: 'GKa', name: attachKeyName('api', 'uploads') },
      { id: 'GKu', name: 'laptop' },
    ]);
    const removed = await gcPlatformKeysWith(ctx, {
      'control-litestream': ['GKc2'],
      'edge-certs-purge': [],
      'edge-certs': null, // unknown — left alone
    });
    expect(removed.sort()).toEqual(['GKc1', 'GKp']);
    expect([...keys.keys()].sort()).toEqual(['GKa', 'GKc2', 'GKe', 'GKu']);
  });
});
