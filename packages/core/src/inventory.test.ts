import { describe, expect, test } from 'bun:test';
import {
  buildInventory,
  FAILING_AFTER_MS,
  STACK_LABEL,
  statusOf,
  summarizeTasks,
  TASK_FAILURE_WINDOW_MS,
  UNGROUPED,
} from './inventory';
import type { ContainerInfo, SwarmServiceInfo } from './protocol';

function svc(p: Partial<SwarmServiceInfo> & { id: string; name: string }): SwarmServiceInfo {
  return {
    id: p.id,
    name: p.name,
    image: p.image ?? 'img:1',
    mode: p.mode ?? 'replicated',
    desiredReplicas: p.desiredReplicas ?? 1,
    runningReplicas: p.runningReplicas ?? 1,
    createdAt: 0,
    updatedAt: 0,
    labels: p.labels ?? {},
    networks: p.networks ?? [],
    env: p.env ?? [],
    ports: p.ports ?? [],
    secrets: p.secrets ?? [],
    configs: p.configs ?? [],
  };
}

test('groups services by docker stack namespace; ungrouped sorts last', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', labels: { [STACK_LABEL]: 'shop' } }),
      svc({ id: 'b', name: 'loner' }),
      svc({ id: 'c', name: 'api', labels: { [STACK_LABEL]: 'shop' } }),
    ],
    [],
  );
  expect(inv.projects.map((p) => p.name)).toEqual(['shop', UNGROUPED]);
  expect(inv.projects[0]!.serviceIds.sort()).toEqual(['a', 'c']);
});

test('infers a network edge between services sharing a non-system overlay net', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', networks: [{ name: 'app', aliases: [] }, { name: 'ingress', aliases: [] }] }),
      svc({ id: 'b', name: 'api', networks: [{ name: 'app', aliases: [] }] }),
      svc({ id: 'c', name: 'lonely', networks: [{ name: 'ingress', aliases: [] }] }),
    ],
    [],
  );
  const netEdges = inv.edges.filter((e) => e.kind === 'network');
  expect(netEdges).toHaveLength(1); // ingress is a system net → ignored
  expect([netEdges[0]!.from, netEdges[0]!.to].sort()).toEqual(['a', 'b']);
});

test('infers a depends edge from an env reference to another service name', () => {
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'api', env: ['DATABASE_URL=postgres://user@postgres:5432/db'] }),
      svc({ id: 'b', name: 'postgres' }),
    ],
    [],
  );
  const dep = inv.edges.find((e) => e.kind === 'depends');
  expect(dep).toBeTruthy();
  expect(dep!.from).toBe('a');
  expect(dep!.to).toBe('b');
});

describe('depends edges come only from names the service can actually reach (QA-082)', () => {
  const stack = (ns: string) => ({ 'com.docker.stack.namespace': ns });
  const on = (...nets: Array<[string, string[]]>) => nets.map(([name, aliases]) => ({ name, aliases }));
  const deps = (services: SwarmServiceInfo[]) =>
    buildInventory(services, []).edges.filter((e) => e.kind === 'depends').map((e) => `${e.from}->${e.to}`);

  test('two unrelated apps on the shared swarmy overlay are not linked by short names', () => {
    expect(
      deps([
        svc({ id: 'demo', name: 'qa-demo_demo', labels: stack('qa-demo'), networks: on(['qa-demo_default', ['demo']], ['swarmy', ['demo']]), env: ['NEXT_PUBLIC_API_URL=https://demo.ayebox.com/api'] }),
        svc({ id: 'api', name: 'qa-queue_api', labels: stack('qa-queue'), networks: on(['qa-queue_default', ['api']], ['swarmy', ['api']]), env: ['PUBLIC_URL=https://demo.ayebox.com'] }),
      ]),
    ).toEqual([]);
  });

  test('a short name links parts of the same app on their own network', () => {
    expect(
      deps([
        svc({ id: 'web', name: 'shop_web', labels: stack('shop'), networks: on(['shop_default', ['web']], ['swarmy', ['web']]), env: ['API_URL=http://api:8080'] }),
        svc({ id: 'api', name: 'shop_api', labels: stack('shop'), networks: on(['shop_default', ['api']]) }),
      ]),
    ).toEqual(['web->api']);
  });

  test('a data service reached over a network the two share counts', () => {
    expect(
      deps([
        svc({ id: 'app', name: 'blog_app', labels: stack('blog'), networks: on(['blog_default', ['app']], ['blog-db_net', []]), env: ['DATABASE_URL=postgres://u@pg-primary:5432/blog'] }),
        svc({ id: 'pg', name: 'blog-db_pg', labels: stack('blog-db'), networks: on(['blog-db_net', ['pg-primary', 'pg']]) }),
      ]),
    ).toEqual(['app->pg']);
  });

  test('an alias only reachable over the swarmy overlay does not count', () => {
    expect(
      deps([
        svc({ id: 'app', name: 'blog_app', labels: stack('blog'), networks: on(['blog_default', ['app']], ['swarmy', []]), env: ['CACHE=redis://cache:6379'] }),
        svc({ id: 'cache', name: 'other_cache', labels: stack('other'), networks: on(['other_default', ['cache']], ['swarmy', ['cache']]) }),
      ]),
    ).toEqual([]);
  });

  test('a full service name is deliberate wiring, whatever the network', () => {
    expect(
      deps([
        svc({ id: 'app', name: 'blog_app', labels: stack('blog'), networks: on(['swarmy', []]), env: ['S3_ENDPOINT=http://swarmy-garage:3900'] }),
        svc({ id: 'garage', name: 'swarmy-garage', labels: stack('swarmy-system'), networks: on(['swarmy', ['garage']]) }),
      ]),
    ).toEqual(['app->garage']);
  });
});

test('attaches containers and marks scale-to-zero idle', () => {
  const containers: ContainerInfo[] = [
    { id: 'ct1', name: 'web.1', image: 'img:1', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: {}, serviceId: 'a' },
  ];
  const inv = buildInventory(
    [
      svc({ id: 'a', name: 'web', runningReplicas: 1 }),
      svc({ id: 'z', name: 'cold', desiredReplicas: 0, runningReplicas: 0, labels: { 'swarmy.scaleToZero.enabled': 'true' } }),
    ],
    containers,
  );
  expect(inv.services.find((s) => s.id === 'a')!.containers).toHaveLength(1);
  const cold = inv.services.find((s) => s.id === 'z')!;
  expect(cold.status).toBe('idle');
  expect(cold.scaleToZero).toBe(true);
});

// ── statusOf / crash-loop detection ─────────────────────────────────────────

const NOW = Date.parse('2026-09-23T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test('statusOf: scaled-to-zero and stopped are chosen states', () => {
  expect(statusOf(0, 0, true)).toBe('idle');
  expect(statusOf(0, 0, false)).toBe('stopped');
});

test('statusOf: full = running, partial = degraded', () => {
  expect(statusOf(2, 2, false)).toBe('running');
  expect(statusOf(3, 1, false, { taskHealth: { recentFailures: 5, starting: false } })).toBe('degraded');
});

test('statusOf: freshly updated with no failures is deploying', () => {
  expect(statusOf(1, 0, false, { updatedAt: NOW - 10_000, now: NOW })).toBe('deploying');
  expect(statusOf(1, 0, false)).toBe('deploying'); // no signals (older agent, no timestamp)
});

test('statusOf: repeated task failures = failing, even right after an update', () => {
  expect(
    statusOf(1, 0, false, {
      taskHealth: { recentFailures: 2, lastError: 'task: non-zero exit (1)', starting: true },
      updatedAt: NOW - 5_000,
      now: NOW,
    }),
  ).toBe('failing');
  // A single failure is still converging.
  expect(
    statusOf(1, 0, false, { taskHealth: { recentFailures: 1, starting: false }, updatedAt: NOW - 5_000, now: NOW }),
  ).toBe('deploying');
});

test('statusOf: nothing up > 2 min after the last update = failing', () => {
  expect(statusOf(1, 0, false, { updatedAt: NOW - FAILING_AFTER_MS - 1, now: NOW })).toBe('failing');
  expect(
    statusOf(1, 0, false, { taskHealth: { recentFailures: 0, starting: false }, updatedAt: NOW - 10 * 60_000, now: NOW }),
  ).toBe('failing');
});

test('statusOf: a slow image pull (task preparing) stays deploying past 2 min', () => {
  expect(
    statusOf(1, 0, false, { taskHealth: { recentFailures: 0, starting: true }, updatedAt: NOW - 10 * 60_000, now: NOW }),
  ).toBe('deploying');
});

test('summarizeTasks: counts recent failed/rejected tasks and keeps the newest error', () => {
  const th = summarizeTasks(
    [
      { DesiredState: 'shutdown', Status: { State: 'failed', Timestamp: iso(60_000), Err: 'task: non-zero exit (1)' } },
      { DesiredState: 'shutdown', Status: { State: 'failed', Timestamp: iso(30_000), Err: 'task: non-zero exit (137)' } },
      { DesiredState: 'shutdown', Status: { State: 'rejected', Timestamp: iso(TASK_FAILURE_WINDOW_MS + 60_000), Err: 'old' } },
      { DesiredState: 'running', Status: { State: 'starting', Timestamp: iso(1_000) } },
    ],
    NOW,
  );
  expect(th.recentFailures).toBe(2);
  expect(th.lastError).toBe('task: non-zero exit (137)');
  expect(th.lastErrorAt).toBe(NOW - 30_000);
  expect(th.starting).toBe(true);
});

test('summarizeTasks: a pending task with a placement error is not "starting"', () => {
  const th = summarizeTasks(
    [{ DesiredState: 'running', Status: { State: 'pending', Timestamp: iso(5_000), Err: 'no suitable node (scheduling constraints not satisfied on 3 nodes)' } }],
    NOW,
  );
  expect(th.starting).toBe(false);
  expect(th.recentFailures).toBe(0);
  expect(th.lastError).toContain('no suitable node');
});

test('buildInventory: a crash-looping service is failing and carries the last error', () => {
  const s = svc({ id: 'a', name: 'web', desiredReplicas: 1, runningReplicas: 0 });
  s.updatedAt = NOW - 30_000;
  s.taskHealth = { recentFailures: 4, lastError: 'task: non-zero exit (1)', lastErrorAt: NOW - 2_000, starting: false };
  const inv = buildInventory([s], [], NOW);
  expect(inv.services[0]!.status).toBe('failing');
  expect(inv.services[0]!.lastError).toBe('task: non-zero exit (1)');
  expect(inv.services[0]!.lastErrorAt).toBe(NOW - 2_000);
});
