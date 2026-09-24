import { describe, expect, test } from 'bun:test';
import {
  accessGroup,
  buildPeopleAccessPlan,
  declaredPorts,
  dexSubject,
  grantGroup,
  isSwarmyManaged,
  planUserSync,
  routerStacks,
  serviceFqdn,
  shortServiceName,
  type PeopleAccessIntent,
} from './people';

function intent(): PeopleAccessIntent {
  return {
    cluster: 'lon',
    stacks: [
      {
        stackId: 'stk_storefront',
        stackName: 'storefront',
        ruleAccess: true,
        services: [
          { name: 'db', vip: '10.201.1.2', ports: [{ port: 5432, proto: 'tcp' }] },
          { name: 'api', vip: '10.201.1.4', ports: [{ port: 8080, proto: 'tcp' }, { port: 9090, proto: 'tcp' }] },
          // no declared ports → never a resource
          { name: 'worker', vip: '10.201.1.6', ports: [] },
          // no VIP (dnsrr / not resolved yet) → never a resource
          { name: 'cache', vip: '', ports: [{ port: 6379, proto: 'tcp' }] },
        ],
        grants: [{ routeId: 'rt_sam', service: 'api', ports: [8080] }],
      },
      {
        stackId: 'stk_blog',
        stackName: 'blog',
        ruleAccess: false,
        services: [{ name: 'db', vip: '10.201.2.2', ports: [{ port: 3306, proto: 'tcp' }] }],
        grants: [],
      },
      {
        stackId: 'stk_dns',
        stackName: 'dns',
        ruleAccess: false,
        services: [{ name: 'coredns', vip: '10.201.3.2', ports: [{ port: 53, proto: 'udp' }, { port: 53, proto: 'tcp' }] }],
        grants: [{ routeId: 'rt_ops' }],
      },
    ],
  };
}

describe('buildPeopleAccessPlan (golden)', () => {
  test('groups, networks, policies and zones for rule access + grants', () => {
    expect(buildPeopleAccessPlan(intent())).toEqual({
      cluster: 'lon',
      groups: [
        'swarmy:lon:access:stk_storefront',
        'swarmy:lon:grant:rt_ops',
        'swarmy:lon:grant:rt_sam',
        'swarmy:lon:res:stk_dns',
        'swarmy:lon:res:stk_storefront',
        'swarmy:lon:router:stk_dns',
        'swarmy:lon:router:stk_storefront',
      ],
      networks: [
        {
          name: 'swarmy-lon-stk_dns',
          description: 'swarmy stack dns',
          routerGroup: 'swarmy:lon:router:stk_dns',
          resources: [{ name: 'coredns', address: '10.201.3.2/32', group: 'swarmy:lon:res:stk_dns' }],
        },
        {
          name: 'swarmy-lon-stk_storefront',
          description: 'swarmy stack storefront',
          routerGroup: 'swarmy:lon:router:stk_storefront',
          resources: [
            { name: 'api', address: '10.201.1.4/32', group: 'swarmy:lon:res:stk_storefront' },
            { name: 'db', address: '10.201.1.2/32', group: 'swarmy:lon:res:stk_storefront' },
          ],
        },
      ],
      policies: [
        {
          name: 'swarmy-lon-stk_dns-coredns',
          sources: ['swarmy:lon:grant:rt_ops'],
          network: 'swarmy-lon-stk_dns',
          resource: 'coredns',
          protocol: 'tcp',
          ports: ['53'],
        },
        {
          name: 'swarmy-lon-stk_dns-coredns-udp',
          sources: ['swarmy:lon:grant:rt_ops'],
          network: 'swarmy-lon-stk_dns',
          resource: 'coredns',
          protocol: 'udp',
          ports: ['53'],
        },
        {
          name: 'swarmy-lon-stk_storefront-api',
          sources: ['swarmy:lon:grant:rt_sam'],
          network: 'swarmy-lon-stk_storefront',
          resource: 'api',
          protocol: 'tcp',
          ports: ['8080'],
        },
        {
          name: 'swarmy-lon-stk_storefront-api-1',
          sources: ['swarmy:lon:access:stk_storefront'],
          network: 'swarmy-lon-stk_storefront',
          resource: 'api',
          protocol: 'tcp',
          ports: ['8080', '9090'],
        },
        {
          name: 'swarmy-lon-stk_storefront-db',
          sources: ['swarmy:lon:access:stk_storefront'],
          network: 'swarmy-lon-stk_storefront',
          resource: 'db',
          protocol: 'tcp',
          ports: ['5432'],
        },
      ],
      zones: [
        {
          name: 'swarmy-lon-stk_dns',
          domain: 'dns.lon.swarmy.internal',
          distributionGroups: ['swarmy:lon:grant:rt_ops'],
          records: [{ name: 'coredns.dns.lon.swarmy.internal', type: 'A', content: '10.201.3.2', ttl: 60 }],
        },
        {
          name: 'swarmy-lon-stk_storefront',
          domain: 'storefront.lon.swarmy.internal',
          distributionGroups: ['swarmy:lon:access:stk_storefront', 'swarmy:lon:grant:rt_sam'],
          records: [
            { name: 'api.storefront.lon.swarmy.internal', type: 'A', content: '10.201.1.4', ttl: 60 },
            { name: 'db.storefront.lon.swarmy.internal', type: 'A', content: '10.201.1.2', ttl: 60 },
          ],
        },
      ],
    });
  });

  test('stable: input order does not change the plan', () => {
    const a = intent();
    const b = intent();
    b.stacks.reverse();
    for (const s of b.stacks) s.services.reverse();
    expect(JSON.stringify(buildPeopleAccessPlan(b))).toBe(JSON.stringify(buildPeopleAccessPlan(a)));
  });

  test('default deny: nothing ever targets the nodes group, no access means no network', () => {
    const plan = buildPeopleAccessPlan(intent());
    expect(plan.groups).not.toContain('swarmy:lon:nodes');
    expect(plan.policies.every((p) => p.sources.every((s) => !s.endsWith(':nodes')))).toBe(true);
    // blog has no rule access and no grants → no router, no zone, no policy
    expect(routerStacks(plan)).toEqual(['stk_dns', 'stk_storefront']);
    expect(plan.zones.some((z) => z.domain.startsWith('blog.'))).toBe(false);
  });

  test('access off everywhere renders an empty plan (routers torn down)', () => {
    const i = intent();
    for (const s of i.stacks) {
      s.ruleAccess = false;
      s.grants = [];
    }
    expect(buildPeopleAccessPlan(i)).toEqual({ cluster: 'lon', groups: [], networks: [], policies: [], zones: [] });
  });
});

describe('names', () => {
  test('are namespaced per cluster', () => {
    expect(accessGroup('lon', 's1')).toBe('swarmy:lon:access:s1');
    expect(grantGroup('lon', 'r1')).toBe('swarmy:lon:grant:r1');
    expect(isSwarmyManaged('lon', 'swarmy:lon:router:s1')).toBe(true);
    expect(isSwarmyManaged('lon', 'swarmy-lon-s1')).toBe(true);
    expect(isSwarmyManaged('lon', 'swarmy:nyc:access:s1')).toBe(false);
    expect(isSwarmyManaged('lon', 'Default')).toBe(false);
  });
  test('FQDNs are DNS-safe', () => {
    expect(serviceFqdn('Lon Prod', 'Store_Front', 'db_primary')).toBe('db-primary.store-front.lon-prod.swarmy.internal');
    expect(shortServiceName('storefront', 'storefront_db')).toBe('db');
    expect(shortServiceName('storefront', 'other_db')).toBe('other_db');
  });
});

describe('declaredPorts', () => {
  test('explicit label wins, and an empty label means none', () => {
    expect(declaredPorts({ labels: { 'swarmy.mesh.ports': '5432, 53/udp,bogus,70000' }, image: 'redis:7' })).toEqual([
      { port: 53, proto: 'udp' },
      { port: 5432, proto: 'tcp' },
    ]);
    expect(declaredPorts({ labels: { 'swarmy.mesh.ports': '' }, image: 'postgres:16' })).toEqual([]);
  });
  test('managed data engines', () => {
    expect(declaredPorts({ labels: { 'swarmy.db.engine': 'postgres' } })).toEqual([{ port: 5432, proto: 'tcp' }]);
    expect(declaredPorts({ labels: { 'swarmy.cache.engine': 'valkey' } })).toEqual([{ port: 6379, proto: 'tcp' }]);
  });
  test('ingress route ports ∪ published targets', () => {
    expect(
      declaredPorts({
        labels: { 'swarmy.ingress.routes': JSON.stringify([{ host: 'a.x', port: 3000 }, { host: 'b.x', port: 3000 }]) },
        ports: [{ target: 9000, protocol: 'tcp' }],
      }),
    ).toEqual([
      { port: 3000, proto: 'tcp' },
      { port: 9000, proto: 'tcp' },
    ]);
  });
  test('well-known images, else nothing', () => {
    expect(declaredPorts({ image: 'docker.io/library/postgres:16-alpine@sha256:abc' })).toEqual([{ port: 5432, proto: 'tcp' }]);
    expect(declaredPorts({ image: 'pgvector/pgvector:pg16' })).toEqual([{ port: 5432, proto: 'tcp' }]);
    expect(declaredPorts({ image: 'valkey/valkey:8' })).toEqual([{ port: 6379, proto: 'tcp' }]);
    expect(declaredPorts({ image: 'ghcr.io/acme/web:1' })).toEqual([]);
  });
});

describe('dexSubject', () => {
  test('decodes the live break-glass owner id seen in the spike', () => {
    expect(dexSubject('CiRmMzUyZDZjZS0yZGQ1LTQ4MjMtYjcxOS01MjMwMGU4OGRhZDMSBWxvY2Fs')).toEqual({
      sub: 'f352d6ce-2dd5-4823-b719-52300e88dad3',
      connector: 'local',
    });
  });
  test('round-trips a connector user and rejects non-Dex ids', () => {
    const enc = (sub: string, conn: string) => {
      const b = new TextEncoder();
      const s = b.encode(sub);
      const c = b.encode(conn);
      return btoa(String.fromCharCode(0x0a, s.length, ...s, 0x12, c.length, ...c));
    };
    expect(dexSubject(enc('usr_abc', 'daqmctca1vds739t9im0'))).toEqual({ sub: 'usr_abc', connector: 'daqmctca1vds739t9im0' });
    expect(dexSubject('487982e9-a016-4d3f-b054-71b2a68dfd73')).toBeNull();
    expect(dexSubject('')).toBeNull();
  });
  test('planUserSync matches on the subject before email', () => {
    const b = new TextEncoder().encode('swarmy-user-1');
    const id = btoa(String.fromCharCode(0x0a, b.length, ...b, 0x12, 3, ...new TextEncoder().encode('cid')));
    const out = planUserSync({
      cluster: 'lon',
      users: [{ id, email: '', isServiceUser: false, isBlocked: false, autoGroups: [] }],
      people: [{ userId: 'swarmy-user-1', email: null, groups: ['swarmy:lon:access:s1'] }],
    });
    expect(out).toEqual([{ nbUserId: id, email: '', autoGroups: ['swarmy:lon:access:s1'], block: false, deletePeers: false, swarmyUserId: 'swarmy-user-1' }]);
  });
});

describe('planUserSync', () => {
  const users = [
    { id: 'u-owner', email: 'owner@swarmy.local', isServiceUser: false, isBlocked: false, autoGroups: [], idpId: 'local', role: 'owner' },
    { id: 'u-svc', email: '', isServiceUser: true, isBlocked: false, autoGroups: [] },
    { id: 'u-priya', email: 'Priya@acme.dev', isServiceUser: false, isBlocked: false, autoGroups: ['team-x', 'swarmy:lon:access:old'] },
    { id: 'u-sam', email: 'sam@acme.dev', isServiceUser: false, isBlocked: false, autoGroups: ['swarmy:lon:access:s1'] },
    { id: 'u-gone', email: 'gone@acme.dev', isServiceUser: false, isBlocked: false, autoGroups: ['swarmy:lon:access:s1', 'swarmy:nyc:access:z'] },
    { id: 'u-back', email: 'back@acme.dev', isServiceUser: false, isBlocked: true, autoGroups: [] },
  ];
  const people = [
    { userId: 'priya', email: 'priya@acme.dev', groups: ['swarmy:lon:access:s1', 'swarmy:lon:grant:r9'] },
    { userId: 'sam', email: 'sam@acme.dev', groups: ['swarmy:lon:access:s1'] },
    { userId: 'back', email: 'back@acme.dev', groups: [] },
  ];

  test('golden: swarmy groups replaced, others kept, leavers blocked, owner and service users untouched', () => {
    expect(planUserSync({ cluster: 'lon', users, people })).toEqual([
      { nbUserId: 'u-back', email: 'back@acme.dev', autoGroups: [], block: false, deletePeers: false, swarmyUserId: 'back' },
      {
        nbUserId: 'u-gone',
        email: 'gone@acme.dev',
        autoGroups: ['swarmy:nyc:access:z'],
        block: true,
        deletePeers: true,
        swarmyUserId: null,
      },
      {
        nbUserId: 'u-priya',
        email: 'Priya@acme.dev',
        autoGroups: ['swarmy:lon:access:s1', 'swarmy:lon:grant:r9', 'team-x'],
        block: false,
        deletePeers: false,
        swarmyUserId: 'priya',
      },
    ]);
  });

  test('converged state plans nothing', () => {
    const converged = [
      { id: 'u-sam', email: 'sam@acme.dev', isServiceUser: false, isBlocked: false, autoGroups: ['swarmy:lon:access:s1'] },
      { id: 'u-gone', email: 'gone@acme.dev', isServiceUser: false, isBlocked: true, autoGroups: [] },
    ];
    expect(planUserSync({ cluster: 'lon', users: converged, people })).toEqual([]);
  });
});
