import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { DeployProgressPayload } from '@swarmy/core/protocol';
import { appRouter } from '../root';
import type { OrgContext } from '../context';
import { DeployEventBus, deployEventBus } from './deploy-events';
import { beginDeployTrace, getDeployEvents, subscribeDeployEvents } from './deploy-trace.service';
import { deployWatchFor, mainServiceOf } from './deploy-roles';

const ev = (deployId: string, over: Partial<DeployProgressPayload> = {}): DeployProgressPayload => ({
  deployId,
  stack: 'blog',
  node: 'london-1',
  stage: 'pull',
  status: 'progress',
  at: 1,
  message: 'ghost:5.96-alpine: 1 of 7 layers',
  ...over,
});
const ctxFor = (orgId: string) => ({ activeOrgId: orgId }) as unknown as OrgContext;

describe('DeployEventBus (relay + replay buffer)', () => {
  it('keeps events in order with a sequence, for the org and stack that began the deploy', () => {
    const bus = new DeployEventBus();
    const id = bus.begin('org_a', 'blog');
    expect(id).toMatch(/^dep_[a-f0-9]{20}$/);
    expect(bus.push('org_a', ev(id))).toBe(true);
    expect(bus.push('org_a', ev(id, { status: 'done', message: 'digest verified' }))).toBe(true);
    expect(bus.get('org_a', id)?.events.map((e) => [e.seq, e.status])).toEqual([[1, 'progress'], [2, 'done']]);
  });

  it('drops a push from another org, for another stack, or for an unknown id (an agent cannot inject into another org)', () => {
    const bus = new DeployEventBus();
    const id = bus.begin('org_a', 'blog');
    expect(bus.push('org_b', ev(id))).toBe(false);
    expect(bus.push('org_a', ev(id, { stack: 'shop' }))).toBe(false);
    expect(bus.push('org_a', ev('dep_0000000000'))).toBe(false);
    expect(bus.get('org_a', id)?.events).toEqual([]);
  });

  it('reads are org-scoped: another org sees nothing and cannot subscribe', () => {
    const bus = new DeployEventBus();
    const id = bus.begin('org_a', 'blog');
    expect(bus.get('org_b', id)).toBeNull();
    expect(bus.subscribe('org_b', id, () => undefined)).toBeNull();
  });

  it('keeps only the last 500 events', () => {
    const bus = new DeployEventBus();
    const id = bus.begin('org_a', 'blog');
    for (let i = 0; i < 520; i++) bus.push('org_a', ev(id, { message: `line ${i}` }));
    const events = bus.get('org_a', id)!.events;
    expect(events.length).toBe(500);
    expect(events[0]!.message).toBe('line 20');
  });

  it('forgets a deploy 30 minutes after its last event', () => {
    let now = 0;
    const bus = new DeployEventBus(() => now);
    const id = bus.begin('org_a', 'blog');
    now = 29 * 60_000;
    expect(bus.get('org_a', id)).not.toBeNull();
    now = 60 * 60_000;
    expect(bus.get('org_a', id)).toBeNull();
  });

  it('live listeners get each event, then null when it finishes', () => {
    const bus = new DeployEventBus();
    const id = bus.begin('org_a', 'blog');
    const got: Array<string | null> = [];
    bus.subscribe('org_a', id, (e) => got.push(e ? e.message : null));
    bus.push('org_a', ev(id, { message: 'a' }));
    bus.finish(id);
    expect(got).toEqual(['a', null]);
    expect(bus.get('org_a', id)?.done).toBe(true);
  });
});

describe('subscribeDeployEvents', () => {
  it('replays what a late subscriber missed, tails the rest, and ends when finished', async () => {
    const bus = new DeployEventBus();
    const trace = beginDeployTrace(ctxFor('org_a'), 'blog', bus);
    trace.emit({ stage: 'data', status: 'started', message: 'Create Postgres cluster db' });
    const ac = new AbortController();
    const it = subscribeDeployEvents(ctxFor('org_a'), trace.id, ac.signal, bus)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.message).toBe('Create Postgres cluster db');
    expect(first.value?.node).toBe('swarmy');
    setTimeout(() => {
      bus.push('org_a', ev(trace.id, { message: 'pulling ghost:5.96-alpine on london-1' }));
      trace.finish();
    }, 5);
    expect((await it.next()).value?.message).toBe('pulling ghost:5.96-alpine on london-1');
    expect((await it.next()).done).toBe(true);
  });

  it('another org gets not-found for get and subscribe', async () => {
    const bus = new DeployEventBus();
    const { id } = beginDeployTrace(ctxFor('org_a'), 'blog', bus);
    expect(() => getDeployEvents(ctxFor('org_b'), id, bus)).toThrow();
    const it = subscribeDeployEvents(ctxFor('org_b'), id, new AbortController().signal, bus)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow();
  });
});

describe('deploy roles', () => {
  const specs = [
    { name: 'blog_db', ports: [] },
    { name: 'blog_ghost', labels: { 'swarmy.ingress.routes': '[{"host":"blog.example.com","port":2368}]' } },
  ];
  it('the routed service is the app; the rest are its data', () => {
    expect(mainServiceOf(specs)).toBe('blog_ghost');
    expect(mainServiceOf(specs, 'db')).toBe('blog_db');
    expect(mainServiceOf([{ name: 'a' }, { name: 'b', ports: [{ target: 80, protocol: 'tcp', mode: 'ingress' }] }])).toBe('b');
    expect(deployWatchFor({ id: 'dep_k2x9q7ab', stack: 'blog' }, specs[0]!, 'blog_ghost')).toEqual({ deployId: 'dep_k2x9q7ab', stack: 'blog', role: 'data' });
  });
});

// ── Router authorization: deploys.get / deploys.events are org-scoped ─────────
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  for (const org of ['org_a', 'org_b']) {
    await t.db.organization.create({ data: { id: org, name: org, slug: org, createdAt: new Date() } });
  }
  for (const [user, org] of [['u_a', 'org_a'], ['u_b', 'org_b']] as const) {
    await t.db.user.create({ data: { id: user, name: user, email: `${user}@a.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await t.db.member.create({ data: { id: `m_${user}`, organizationId: org, userId: user, role: 'member', createdAt: new Date() } });
  }
});
afterAll(async () => {
  await t?.close();
});

const caller = (userId: string, activeOrgId: string) =>
  appRouter.createCaller({
    db: t.db,
    hub: {},
    session: { id: `s_${userId}`, token: `t_${userId}` },
    user: { id: userId, email: `${userId}@a.dev`, name: userId },
    activeOrgId,
    reqHeaders: new Headers(),
  } as unknown as OrgContext);

describe('deploys router (authorization)', () => {
  it('the org that started the deploy reads its events', async () => {
    const trace = beginDeployTrace(ctxFor('org_a'), 'blog');
    trace.emit({ stage: 'route', status: 'started', message: 'route https://blog.example.com added' });
    const got = await caller('u_a', 'org_a').deploys.get({ deployId: trace.id });
    expect(got.stack).toBe('blog');
    expect(got.events.map((e) => e.message)).toEqual(['route https://blog.example.com added']);
    trace.finish();
  });

  it('a user from another org cannot read or subscribe to it', async () => {
    const trace = beginDeployTrace(ctxFor('org_a'), 'blog');
    await expect(caller('u_b', 'org_b').deploys.get({ deployId: trace.id })).rejects.toThrow(/not found/i);
    const sub = await caller('u_b', 'org_b').deploys.events({ deployId: trace.id });
    await expect((sub as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()).rejects.toThrow(/not found/i);
    trace.finish();
  });

  it('pointing the session at an org the user is not in is refused outright', async () => {
    const trace = beginDeployTrace(ctxFor('org_a'), 'blog');
    await expect(caller('u_b', 'org_a').deploys.get({ deployId: trace.id })).rejects.toThrow(/not a member/i);
    expect(deployEventBus.get('org_a', trace.id)).not.toBeNull();
    trace.finish();
  });
});
