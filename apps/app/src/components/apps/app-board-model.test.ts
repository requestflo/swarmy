import { describe, expect, test } from 'bun:test';
import type { IncidentView, InvService, NodeSummary, ReleaseView } from '@swarmy/core';
import { buildRows, envPills, groupRows, incidentFor, poolFor, statusCounts, type GitAppLike } from './app-board-model';
import type { AppWords } from './app-words';
import type { AppItem } from './use-apps';

const svc = (name: string): InvService => ({ id: `svc-${name}`, name, replicas: { desired: 1, running: 1 } }) as InvService;

function app(name: string, tone: AppWords['tone'], hosts: string[] = [], services = ['web']): AppItem {
  return {
    name,
    host: hosts[0] ?? null,
    hosts,
    words: { tone, word: '', say: 'x.', tech: '', attention: tone === 'warn' || tone === 'bad' },
    stat: { name, services: services.map(svc), serviceCount: services.length } as AppItem['stat'],
  };
}

const git: GitAppLike[] = [
  {
    appName: 'storefront',
    environments: [
      { environment: 'production', stack: 'storefront' },
      { environment: 'staging', stack: 'storefront-staging' },
    ],
    previews: [{ stack: 'storefront-pr-214', pr: 214 }],
  },
];

const APPS = [
  app('storefront', 'ok', ['shop.northwind.dev']),
  app('storefront-staging', 'ok'),
  app('storefront-pr-214', 'idle'),
  app('analytics', 'warn', ['stats.northwind.dev'], ['app', 'db']),
  app('blog', 'idle'),
];

describe('environments', () => {
  test('a production row names its other environments and previews', () => {
    expect(envPills('storefront', git).map((p) => p.label)).toEqual(['production', 'staging', '1 preview']);
  });
  test('a staging or preview row names only itself', () => {
    expect(envPills('storefront-staging', git)).toEqual([{ label: 'staging', kind: 'staging' }]);
    expect(envPills('storefront-pr-214', git)).toEqual([{ label: 'preview', kind: 'preview' }]);
  });
  test('an app with no git link is production', () => {
    expect(envPills('blog', git)).toEqual([{ label: 'production', kind: 'production' }]);
  });
});

describe('filters and grouping', () => {
  const rows = buildRows({ apps: APPS, gitApps: git });
  test('ungrouped shows production only', () => {
    expect(poolFor(rows, 'none').map((r) => r.app.name)).toEqual(['storefront', 'analytics', 'blog']);
  });
  test('status counts follow search', () => {
    const pool = poolFor(rows, 'none');
    expect(statusCounts(pool, '')).toEqual({ all: 3, attn: 1, ok: 1, idle: 1 });
    expect(statusCounts(pool, 'northwind')).toEqual({ all: 2, attn: 1, ok: 1, idle: 0 });
  });
  test('search matches addresses and filters combine', () => {
    expect(groupRows(rows, 'none', 'stats', 'all')[0]!.rows.map((r) => r.app.name)).toEqual(['analytics']);
    expect(groupRows(rows, 'none', '', 'idle')[0]!.rows.map((r) => r.app.name)).toEqual(['blog']);
    expect(groupRows(rows, 'none', 'nothing-here', 'all')).toEqual([]);
  });
  test('grouping by environment: production, staging, previews', () => {
    const g = groupRows(rows, 'env', '', 'all');
    expect(g.map((x) => [x.label, x.rows.length])).toEqual([
      ['Production', 3],
      ['Staging', 1],
      ['Previews', 1],
    ]);
    expect(g[0]!.hint).toBe('what visitors use');
  });
});

describe('the needs-you row', () => {
  const rel = (id: string, status: ReleaseView['status']): ReleaseView =>
    ({ id, stackName: 'analytics', status, images: [{ name: 'app', image: `app:${id}` }], actor: null, createdAt: new Date().toISOString() }) as ReleaseView;
  const inc = (id: string, title: string): IncidentView => ({ id, title, status: 'open' }) as IncidentView;

  test('put back the last healthy version; link the incident that names a part', () => {
    const [row] = buildRows({
      apps: [APPS[3]!],
      releases: [rel('42', 'healthy'), rel('41', 'superseded')],
      incidents: [inc('i-1', 'db is slow since the 09:14 deploy')],
    });
    expect(row!.fix?.putBack?.id).toBe('41');
    expect(row!.fix?.incidentId).toBe('i-1');
  });
  test('no earlier version → no put-back', () => {
    const [row] = buildRows({ apps: [APPS[3]!], releases: [rel('42', 'healthy')] });
    expect(row!.fix?.putBack).toBeNull();
  });
  test('incidents match whole names only', () => {
    expect(incidentFor(APPS[3]!, [inc('i', 'analytics-v2 is down')])).toBeNull();
    expect(incidentFor(APPS[3]!, [inc('i', 'Analytics is slow')])?.id).toBe('i');
  });
  test('placement: servers undefined until known, null when on none', () => {
    expect(buildRows({ apps: [APPS[4]!] })[0]!.servers).toBeUndefined();
    expect(buildRows({ apps: [APPS[4]!], placement: new Map() })[0]!.servers).toBeNull();
    const n = { id: 'n', name: 'london-2', region: 'eu-west', publicIp: null } as NodeSummary;
    expect(buildRows({ apps: [APPS[4]!], placement: new Map([['blog', [n]]]) })[0]!.servers?.primary).toBe('london-2');
  });
});
