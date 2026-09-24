import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { STACK_LABEL } from '@swarmy/core';
import type { OrgContext } from '../context';
import { detectStudioTargets, executeStudio, listStudioTargets, prepareStatement, studioHistory, STUDIO_AUDIT_ACTION } from './studio.service';

type Role = 'owner' | 'admin' | 'member';

interface Harness {
  ctx: OrgContext;
  audit: Array<{ action: string; metadata?: Record<string, unknown> }>;
  dispatched: Array<{ nodeId: string; cmd: string; payload: Record<string, unknown> }>;
}

const svc = (over: Record<string, unknown> = {}) => ({
  id: 'svc-db',
  name: 'shop_db',
  image: 'mysql:8.4',
  mode: 'replicated',
  runningReplicas: 1,
  createdAt: 0,
  updatedAt: 0,
  labels: { [STACK_LABEL]: 'shop' },
  networks: [],
  env: ['MYSQL_ROOT_PASSWORD=hunter2', 'MYSQL_DATABASE=app'],
  ports: [],
  mounts: [],
  ...over,
});

function harness(role: Role, opts: { labels?: Record<string, string>; reply?: unknown; fail?: string } = {}): Harness {
  const audit: Harness['audit'] = [];
  const dispatched: Harness['dispatched'] = [];
  const services = [svc({ labels: { [STACK_LABEL]: 'shop', ...(opts.labels ?? {}) } })];
  const containers = [{ id: 'c1', serviceId: 'svc-db', state: 'running', labels: {} }];
  const db = {
    member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
    policy: { findMany: async () => [] },
    resourceGrant: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: { data: { action: string; metadata?: Record<string, unknown> } }) => {
        audit.push({ action: data.action, metadata: data.metadata });
        return {};
      },
      findMany: async () =>
        audit
          .filter((a) => a.action === STUDIO_AUDIT_ACTION)
          .map((a, i) => ({ id: BigInt(i + 1), ts: new Date(0), metadata: a.metadata })),
    },
  };
  const hub = {
    liveInventory: () => ({ services, containers }),
    onlineNodeIds: () => ['node1'],
    latestContainers: () => containers,
    nodeInfoFor: () => undefined,
    dispatch: async (nodeId: string, cmd: string, payload: Record<string, unknown>) => {
      dispatched.push({ nodeId, cmd, payload });
      if (opts.fail) throw new Error(opts.fail);
      return opts.reply ?? { engine: 'mysql', columns: ['a'], rows: [['1']], rowCount: 1, truncated: false, notices: [], durationMs: 3 };
    },
  };
  const ctx = {
    db,
    hub,
    session: { id: 's1' },
    user: { id: 'user1', email: 'u@example.com', name: 'u' },
    membership: { role, orgId: 'org1' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, audit, dispatched };
}

const run = (h: Harness, statement: string, confirm?: string) => executeStudio(h.ctx, { stack: 'shop', target: 'shop_db', statement, confirm });

async function rejects(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    return e as TRPCError;
  }
  throw new Error('expected a rejection');
}

describe('studio targets', () => {
  it('finds compose DBs and managed primaries, never plumbing or replicas', () => {
    const t = detectStudioTargets(
      [
        svc(),
        svc({ id: 'p', name: 'shop_pg-primary', image: 'pgvector/pgvector:pg17', env: ['POSTGRES_PASSWORD=x', 'POSTGRES_DB=shop'], labels: { [STACK_LABEL]: 'shop', 'swarmy.db.cluster': 'pg', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary' } }),
        svc({ id: 'r', name: 'shop_pg-replica', image: 'pgvector/pgvector:pg17', labels: { [STACK_LABEL]: 'shop', 'swarmy.db.cluster': 'pg', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'replica' } }),
        svc({ id: 'k', name: 'shop_cache', image: 'valkey/valkey:8', labels: { [STACK_LABEL]: 'shop', 'swarmy.cache.name': 'c' } }),
        svc({ id: 'w', name: 'shop_web', image: 'nginx', labels: { [STACK_LABEL]: 'shop' } }),
        svc({ id: 'o', name: 'blog_db', labels: { [STACK_LABEL]: 'blog' } }),
      ] as never,
      'shop',
    );
    expect(t.map((x) => [x.name, x.kind, x.engine, x.defaultDatabase])).toEqual([
      ['pg', 'managed', 'postgres', 'shop'],
      ['shop_db', 'compose', 'mysql', 'app'],
    ]);
  });

  it('the target list never carries a credential value', () => {
    const h = harness('member');
    const list = listStudioTargets(h.ctx, 'shop');
    expect(list[0]).toMatchObject({ name: 'shop_db', running: true, unavailable: null });
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });
});

describe('studio gate', () => {
  it('a member reads a non-production database; one audit row with the statement, no values', async () => {
    const h = harness('member');
    const r = await run(h, 'SELECT * FROM users');
    expect(r.classification.class).toBe('read');
    expect(h.dispatched).toHaveLength(1);
    const { payload } = h.dispatched[0]!;
    expect(h.dispatched[0]!.cmd).toBe('db.query');
    expect(payload.op).toEqual({ kind: 'sql', statement: 'SELECT * FROM users', access: 'read' });
    expect(payload.database).toBe('app');
    expect(JSON.stringify(payload)).not.toContain('hunter2');
    const rows = h.audit.filter((a) => a.action === STUDIO_AUDIT_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ statement: 'SELECT * FROM users', class: 'read', status: 'ok', rows: 1, origin: 'console' });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('"1"'); // result values are not audited
  });

  it('a member is refused production reads, and the deny is audited', async () => {
    const h = harness('member', { labels: { 'swarmy.env': 'production' } });
    const e = await rejects(run(h, 'SELECT 1'));
    expect(e.code).toBe('FORBIDDEN');
    expect(h.dispatched).toHaveLength(0);
    expect(h.audit.map((a) => a.action)).toEqual(['authz.deny:data.read']);
  });

  it('writes need data.write (members are refused by default, admins permitted)', async () => {
    const m = harness('member');
    expect((await rejects(run(m, "UPDATE users SET a = 1 WHERE id = 2"))).code).toBe('FORBIDDEN');
    expect(m.audit.map((a) => a.action)).toContain('authz.deny:data.write');
    const a = harness('admin');
    const r = await run(a, "UPDATE users SET a = 1 WHERE id = 2");
    expect(r.classification.class).toBe('write');
    expect(a.dispatched[0]!.payload.op).toMatchObject({ access: 'write' });
    expect(a.audit.map((x) => x.action)).toEqual(['authz.permit:data.write', STUDIO_AUDIT_ACTION]);
  });

  it('destructive statements need data.destroy AND the database name typed back', async () => {
    const a = harness('admin');
    const e = await rejects(run(a, 'DELETE FROM users'));
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect((e.cause as { swarmyCode?: string }).swarmyCode).toBe('CONFIRM_REQUIRED');
    expect(a.dispatched).toHaveLength(0);
    expect((await rejects(run(a, 'DROP TABLE users', 'shop'))).code).toBe('PRECONDITION_FAILED');
    await run(a, 'DROP TABLE users', 'shop_db');
    expect(a.audit.map((x) => x.action)).toEqual(['authz.permit:data.destroy', STUDIO_AUDIT_ACTION]);
    const m = harness('member');
    expect((await rejects(run(m, 'DROP TABLE users', 'shop_db'))).code).toBe('FORBIDDEN');
  });

  it('blocked statements never dispatch', async () => {
    const a = harness('owner');
    const e = await rejects(run(a, 'SELECT 1; DROP TABLE users'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toContain('one statement at a time');
    expect(a.dispatched).toHaveLength(0);
  });

  it('agent errors map to stable codes and are audited as failed', async () => {
    const h = harness('member', { fail: 'E_STUDIO_TIMEOUT: the query ran past 15s' });
    const e = await rejects(run(h, 'SELECT pg_sleep(60)'));
    expect(e.code).toBe('TIMEOUT');
    expect(h.audit.at(-1)!.metadata).toMatchObject({ status: 'failed' });
  });

  it('history reads my console rows back from the audit log', async () => {
    const h = harness('member');
    await run(h, 'SELECT 1');
    const rows = await studioHistory(h.ctx, { stack: 'shop', target: 'shop_db' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ statement: 'SELECT 1', class: 'read', status: 'ok' });
  });
});

describe('prepareStatement', () => {
  it('translates Mongo shorthand and Redis command lines to the op that runs', () => {
    const m = prepareStatement('mongo', 'db.users.find({ a: 1 }).limit(5)', 'db');
    expect(m.op).toEqual({ kind: 'mongo', command: '{"find":"users","filter":{"a":1},"limit":5}', access: 'read' });
    const r = prepareStatement('redis', 'SET "a b" 1', 'cache');
    expect(r.op).toEqual({ kind: 'redis', argv: ['SET', 'a b', '1'], access: 'write' });
    expect(r.display).toBe('SET "a b" 1');
    expect(prepareStatement('redis', 'FLUSHALL', 'cache')).toMatchObject({ action: 'data.destroy', confirmPhrase: 'cache' });
  });
});
