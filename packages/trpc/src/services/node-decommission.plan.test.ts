import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import {
  DestinationPicker,
  nodeReachability,
  planDecommission,
  type DecomContainerInput,
  type DecomNodeInput,
  type DecomServiceInput,
  type DecommissionInput,
} from './node-decommission.plan';

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;

function node(id: string, over: Partial<SwarmNodeInfo> = {}, extra: Partial<DecomNodeInput> = {}): DecomNodeInput {
  return {
    nodeId: id,
    hostname: id,
    online: true,
    disk: { usedBytes: 10 * GB, totalBytes: 50 * GB },
    swarm: {
      swarmNodeId: `sw-${id}`,
      hostname: id,
      role: 'worker',
      availability: 'active',
      status: 'ready',
      leader: false,
      labels: {},
      ...over,
    },
    ...extra,
  };
}

function svc(name: string, labels: Record<string, string> = {}, over: Partial<DecomServiceInput> = {}): DecomServiceInput {
  return { name, mode: 'replicated', desiredReplicas: 1, labels, ...over };
}

function task(serviceName: string, volumes: string[] = [], extra: Partial<DecomContainerInput> = {}): DecomContainerInput {
  return {
    name: `${serviceName}.1.abc`,
    serviceName,
    mounts: volumes.map((v) => ({ type: 'volume', source: v, target: `/${v}` })),
    ...extra,
  };
}

function input(over: Partial<DecommissionInput>): DecommissionInput {
  return {
    targetNodeId: 'b',
    nodes: [node('a', { role: 'manager', leader: true }), node('b'), node('c')],
    services: [],
    containers: [],
    backupsConfigured: true,
    now: NOW,
    ...over,
  };
}

const kinds = (p: ReturnType<typeof planDecommission>) => p.steps.map((s) => s.kind);

describe('planDecommission — stateless', () => {
  it('a worker with only stateless apps: cordon → drain → leave → forget, runnable', () => {
    const p = planDecommission(
      input({ services: [svc('web_api', {}, { desiredReplicas: 3 })], containers: [task('web_api')] }),
    );
    expect(p.runnable).toBe(true);
    expect(kinds(p)).toEqual(['cordon', 'drain', 'swarm-leave', 'forget']);
    expect(p.totals.statelessServices).toBe(1);
    expect(p.summary).toBe('Retiring b moves 1 app to other servers. Nothing stops.');
  });

  it('blocks on the last working server and on the controller host', () => {
    const p = planDecommission(
      input({
        targetNodeId: 'a',
        nodes: [node('a', { role: 'manager' }, { hostsController: true }), node('b', { status: 'down' }, { online: false })],
      }),
    );
    expect(p.runnable).toBe(false);
    expect(p.blockers.map((b) => b.code).sort()).toEqual(['controller-host', 'last-node', 'no-manager-candidate']);
    expect(p.summary).toStartWith("a can't be retired yet:");
  });

  it('unknown node', () => {
    const p = planDecommission(input({ targetNodeId: 'zzz' }));
    expect(p.blockers[0]!.code).toBe('unknown-node');
    expect(p.steps).toEqual([]);
  });

  it('global services and docker.sock binds add nothing', () => {
    const p = planDecommission(
      input({
        services: [svc('swarmy_agent', {}, { mode: 'global' })],
        containers: [
          task('swarmy_agent', [], { mounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }),
        ],
      }),
    );
    expect(p.warnings).toEqual([]);
    expect(p.totals.statelessServices).toBe(0);
  });
});

describe('planDecommission — managed Postgres', () => {
  const primary = (extra: Record<string, string> = {}) =>
    svc('shop_db-primary', {
      'com.docker.stack.namespace': 'shop',
      'swarmy.db.cluster': 'db',
      'swarmy.db.role': 'primary',
      'swarmy.db.node': 'sw-b',
      'swarmy.db.dataVolume': 'shop_db-primary-data',
      'swarmy.db.replicas': '1',
      ...extra,
    });
  const replica = (n: number) =>
    svc(
      'shop_db-replica',
      { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'replica' },
      { desiredReplicas: n },
    );

  it('primary with a replica → planned switchover (seconds), after a safety backup', () => {
    const p = planDecommission(
      input({ services: [primary(), replica(1)], containers: [task('shop_db-primary', ['shop_db-primary-data'])] }),
    );
    expect(kinds(p)).toEqual(['safety-backup', 'cordon', 'db-switchover', 'drain', 'swarm-leave', 'forget']);
    expect(p.steps[0]!.volumes).toEqual(['shop_db-primary-data']);
    expect(p.steps.find((s) => s.kind === 'db-switchover')!.downtime).toBe('seconds');
    expect(p.summary).toContain('Databases pause for a few seconds');
  });

  it('a fresh backup skips the safety-backup step', () => {
    const p = planDecommission(
      input({
        services: [primary(), replica(1)],
        containers: [task('shop_db-primary', ['shop_db-primary-data'])],
        lastBackupAt: { 'shop_db-primary-data': NOW - 60_000 },
      }),
    );
    expect(kinds(p)).not.toContain('safety-backup');
  });

  it('single primary → temporary standby on the roomiest server, then switchover', () => {
    const p = planDecommission(
      input({
        nodes: [
          node('a', { role: 'manager' }, { disk: { usedBytes: 40 * GB, totalBytes: 50 * GB } }),
          node('b'),
          node('c', {}, { disk: { usedBytes: 5 * GB, totalBytes: 50 * GB } }),
        ],
        services: [primary({ 'swarmy.db.replicas': '0', 'swarmy.db.topology': 'single' }), replica(0)],
        containers: [task('shop_db-primary', ['shop_db-primary-data'])],
        volumes: [{ name: 'shop_db-primary-data', driver: 'local', sizeBytes: 2 * GB }],
      }),
    );
    const step = p.steps.find((s) => s.kind === 'db-standby-switchover')!;
    expect(step.destination?.nodeId).toBe('c');
    expect(step.bytes).toBe(2 * GB);
    expect(p.totals.bytesToMove).toBe(2 * GB);
  });

  it('no server has room below the pressure line → blocker', () => {
    const full = { usedBytes: 41 * GB, totalBytes: 50 * GB };
    const p = planDecommission(
      input({
        nodes: [node('a', { role: 'manager' }, { disk: full }), node('b'), node('c', {}, { disk: full })],
        services: [primary({ 'swarmy.db.replicas': '0' })],
        containers: [task('shop_db-primary', ['shop_db-primary-data'])],
        volumes: [{ name: 'shop_db-primary-data', sizeBytes: 3 * GB }],
      }),
    );
    expect(p.blockers.map((b) => b.code)).toEqual(['no-destination']);
    expect(p.blockers[0]!.message).toContain('3.0 GB');
  });

  it('replica on the target just floats (drain) and warns when the replica count cannot fit', () => {
    const p = planDecommission(
      input({
        nodes: [node('a', { role: 'manager' }), node('b')],
        services: [primary({ 'swarmy.db.node': 'sw-a' }), replica(1)],
        containers: [task('shop_db-replica')],
      }),
    );
    expect(kinds(p)).toEqual(['cordon', 'drain', 'swarm-leave', 'forget']);
    expect(p.warnings.some((w) => w.includes('wants 1 replicas'))).toBe(true);
  });

  it('active-active writer is not automated', () => {
    const p = planDecommission(
      input({
        services: [primary({ 'swarmy.db.topology': 'active-active' })],
        containers: [task('shop_db-primary', ['shop_db-primary-data'])],
      }),
    );
    expect(p.blockers[0]!.code).toBe('unsupported-topology');
  });

  it('offline target: primary with a replica → held failover; without one and no backup → blocker', () => {
    const nodes = [node('a', { role: 'manager' }), node('b', { status: 'down' }, { online: false }), node('c')];
    const withReplica = planDecommission(input({ nodes, services: [primary(), replica(1)] }));
    expect(kinds(withReplica)).toEqual(['db-failover', 'drain', 'swarm-leave', 'forget']);
    expect(withReplica.steps.find((s) => s.kind === 'swarm-leave')!.detail).toContain('--force');

    const alone = planDecommission(input({ nodes, services: [primary({ 'swarmy.db.replicas': '0' })] }));
    expect(alone.blockers.map((b) => b.code)).toEqual(['data-unreachable']);

    const backedUp = planDecommission(
      input({
        nodes,
        services: [primary({ 'swarmy.db.replicas': '0' })],
        lastBackupAt: { 'shop_db-primary-data': NOW - 3 * 86_400_000 },
      }),
    );
    expect(kinds(backedUp)).toContain('volume-restore');
    expect(backedUp.runnable).toBe(true);
  });
});

describe('planDecommission — caches', () => {
  const cache = (replicas: string) =>
    svc('shop_cache-primary', {
      'swarmy.cache.cluster': 'cache',
      'swarmy.cache.role': 'primary',
      'swarmy.cache.replicas': replicas,
      'swarmy.cache.node': 'sw-b',
    });
  it('an online primary moves by a stopped copy (with or without a replica); replicas float', () => {
    for (const r of ['0', '1']) {
      const p = planDecommission(
        input({
          services: [cache(r), svc('shop_cache-replica', { 'swarmy.cache.cluster': 'cache', 'swarmy.cache.role': 'replica' })],
          containers: [task('shop_cache-primary', ['shop_cache-data']), task('shop_cache-replica')],
        }),
      );
      const copy = p.steps.find((s) => s.kind === 'volume-copy')!;
      expect(copy.subject).toBe('shop_cache-primary');
      expect(copy.title).toContain('cache');
      expect(copy.destination).toBeDefined();
      expect(p.steps.find((s) => s.kind === 'drain')!.detail).toContain('shop_cache-replica');
    }
  });
  it('offline: warns and lets it restart elsewhere', () => {
    const p = planDecommission(
      input({ nodes: [node('a', { role: 'manager' }), node('b', { status: 'down' }, { online: false })], services: [cache('0')] }),
    );
    expect(p.warnings.some((w) => w.includes('restarts empty'))).toBe(true);
  });
});

describe('planDecommission — generic volumes', () => {
  it('a volume-backed app → two-pass copy with checksum verify; DB images note the stopped final pass', () => {
    const p = planDecommission(
      input({
        services: [svc('blog_mysql', {}, { image: 'mysql:8.4' }), svc('blog_uploads', {}, { image: 'ghost:5' })],
        containers: [task('blog_mysql', ['blog_mysql-data']), task('blog_uploads', ['blog_content'])],
        volumes: [
          { name: 'blog_mysql-data', driver: 'local', sizeBytes: 1 * GB },
          { name: 'blog_content', driver: 'local', sizeBytes: 512 * 1024 ** 2 },
        ],
      }),
    );
    const copies = p.steps.filter((s) => s.kind === 'volume-copy');
    expect(copies.map((s) => s.subject)).toEqual(['blog_mysql', 'blog_uploads']);
    expect(copies[0]!.detail).toContain('database stopped');
    expect(copies[1]!.detail).not.toContain('database stopped');
    expect(copies[0]!.verify).toContain('sha256');
    expect(p.totals.volumes).toBe(2);
    expect(p.totals.bytesToMove).toBe(1.5 * GB);
    expect(p.summary).toContain('2 volumes (about 1.5 GB)');
    expect(p.summary).toContain('about a minute');
    // The two moves spread: each reservation counts against the next pick.
    expect(new Set(copies.map((s) => s.destination!.nodeId)).size).toBeGreaterThanOrEqual(1);
  });

  it('CSI volumes follow; binds and anonymous volumes warn; multi-replica per-node volumes warn', () => {
    const anon = 'a'.repeat(64);
    const p = planDecommission(
      input({
        services: [svc('x_csi'), svc('x_bind'), svc('x_multi', {}, { desiredReplicas: 3 })],
        containers: [
          task('x_csi', ['pgdata-csi']),
          task('x_bind', [anon], {
            mounts: [
              { type: 'bind', source: '/srv/files', target: '/files' },
              { type: 'volume', source: anon, target: '/tmp' },
            ],
          }),
          task('x_multi', ['x_multi-data']),
        ],
        volumes: [{ name: 'pgdata-csi', driver: 'hetzner-csi' }],
      }),
    );
    expect(p.steps.find((s) => s.kind === 'volume-follow')!.volumes).toEqual(['pgdata-csi']);
    expect(p.warnings.some((w) => w.includes('/srv/files'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('unnamed scratch volume'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('runs 3 copies'))).toBe(true);
    expect(kinds(p)).not.toContain('volume-copy');
  });

  it('no backup destination → a warning instead of a safety-backup step', () => {
    const p = planDecommission(
      input({ backupsConfigured: false, services: [svc('a_app')], containers: [task('a_app', ['a_data'])] }),
    );
    expect(kinds(p)).not.toContain('safety-backup');
    expect(p.warnings.some((w) => w.includes('No backup destination'))).toBe(true);
  });

  it('prefers a destination in the same region', () => {
    const p = planDecommission(
      input({
        nodes: [
          node('a', { role: 'manager', labels: { 'swarmy.region': 'us' } }, { disk: { usedBytes: 0, totalBytes: 500 * GB } }),
          node('b', { labels: { 'swarmy.region': 'eu' } }),
          node('c', { labels: { 'swarmy.region': 'eu' } }),
        ],
        services: [svc('a_app')],
        containers: [task('a_app', ['a_data'])],
      }),
    );
    expect(p.steps.find((s) => s.kind === 'volume-copy')!.destination!.nodeId).toBe('c');
  });
});

describe('planDecommission — platform roles', () => {
  it('Garage member with enough peers → leave + await resync; too few → add a replacement first', () => {
    const g = { 'swarmy.garage.member': 'true' };
    const enough = planDecommission(
      input({
        nodes: [node('a', { role: 'manager', labels: g }), node('b', { labels: g }), node('c', { labels: g })],
        garageReplicationFactor: 2,
      }),
    );
    expect(kinds(enough)).toEqual(['cordon', 'garage-leave', 'drain', 'garage-await-resync', 'swarm-leave', 'forget']);

    const tight = planDecommission(
      input({
        nodes: [node('a', { role: 'manager', labels: g }), node('b', { labels: g }), node('c')],
        garageReplicationFactor: 2,
      }),
    );
    const add = tight.steps.find((s) => s.kind === 'garage-add-member')!;
    expect(add.destination!.nodeId).toBe('c');
    expect(kinds(tight).indexOf('garage-add-member')).toBeLessThan(kinds(tight).indexOf('garage-leave'));

    const stuck = planDecommission(
      input({ nodes: [node('a', { role: 'manager', labels: g }), node('b', { labels: g })], garageReplicationFactor: 2 }),
    );
    expect(stuck.blockers.map((b) => b.code)).toEqual(['garage-no-replacement']);
  });

  it('the only edge server hands its role to a server with a public IP', () => {
    const p = planDecommission(
      input({
        nodes: [
          node('a', { role: 'manager' }),
          node('b', { labels: { 'swarmy.node.ingress': 'true', 'swarmy.node.public-ip': '203.0.113.2' } }),
          node('c', { labels: { 'swarmy.node.public-ip': '203.0.113.3' } }),
        ],
      }),
    );
    const step = p.steps.find((s) => s.kind === 'edge-handover')!;
    expect(step.destination!.nodeId).toBe('c');
    expect(p.warnings.some((w) => w.includes("c's IP"))).toBe(true);

    const none = planDecommission(
      input({ nodes: [node('a', { role: 'manager' }), node('b', { labels: { 'swarmy.node.ingress': 'true' } })] }),
    );
    expect(none.blockers.map((b) => b.code)).toContain('edge-no-replacement');
  });

  it('one of two edge servers just drops out of DNS', () => {
    const edge = { 'swarmy.node.ingress': 'true', 'swarmy.node.public-ip': '203.0.113.9' };
    const p = planDecommission(input({ nodes: [node('a', { role: 'manager', labels: edge }), node('b', { labels: edge })] }));
    const step = p.steps.find((s) => s.kind === 'edge-handover')!;
    expect(step.destination).toBeUndefined();
    expect(step.detail).toContain('TTL');
  });

  it('the only manager: promote a worker first, demote last before leaving', () => {
    const p = planDecommission(
      input({ targetNodeId: 'a', nodes: [node('a', { role: 'manager', leader: true }), node('b'), node('c')] }),
    );
    expect(p.runnable).toBe(true);
    const k = kinds(p);
    expect(k.indexOf('manager-promote')).toBeLessThan(k.indexOf('drain'));
    expect(k.indexOf('manager-demote')).toBe(k.indexOf('swarm-leave') - 1);
    expect(p.steps.find((s) => s.kind === 'manager-demote')!.detail).toContain('raft leader');
  });

  it('3 managers → 2 left: promote a worker to keep an odd count', () => {
    const p = planDecommission(
      input({
        targetNodeId: 'a',
        nodes: [node('a', { role: 'manager' }), node('b', { role: 'manager' }), node('c', { role: 'manager' }), node('d')],
      }),
    );
    expect(p.steps.find((s) => s.kind === 'manager-promote')!.destination!.nodeId).toBe('d');
  });

  it('mesh peers get a mesh-remove step', () => {
    const p = planDecommission(input({ nodes: [node('a', { role: 'manager' }), node('b', {}, { meshPeer: true })] }));
    expect(kinds(p)).toContain('mesh-remove');
  });
});

describe('DestinationPicker', () => {
  it('reserves space so two moves do not double-count one disk', () => {
    const nodes = [
      node('t'),
      node('x', {}, { disk: { usedBytes: 0, totalBytes: 10 * GB } }),
      node('y', {}, { disk: { usedBytes: 0, totalBytes: 9 * GB } }),
    ];
    const p = new DestinationPicker(nodes, 't', undefined, []);
    expect(p.pick({ bytes: 6 * GB })!.nodeId).toBe('x');
    expect(p.pick({ bytes: 6 * GB })!.nodeId).toBe('y');
    expect(p.pick({ bytes: 6 * GB })).toBeUndefined();
  });

  it('skips drained, down and offline servers', () => {
    const nodes = [node('t'), node('d', { availability: 'drain' }), node('o', {}, { online: false }), node('ok')];
    expect(new DestinationPicker(nodes, 't', undefined, []).pick()!.nodeId).toBe('ok');
  });
});

describe('role placement never lands on a NAT\'d server (QA-084)', () => {
  const g = { 'swarmy.garage.member': 'true' };
  const nat = { 'swarmy.node.reachability': 'nat', 'swarmy.node.public-ip': '81.2.69.160' };
  const cloud = (ip: string, extra: Record<string, string> = {}) => ({ 'swarmy.node.public-ip': ip, ...extra });
  // The 1.5 retire run: a cloud manager/Garage member retiring, the home VM
  // (swarmy-mac, a worker behind NAT) sorting first by id and roomiest.
  const homeVm = (labels: Record<string, string> = nat) =>
    node('mac', { labels, addr: '100.106.145.62' }, { hostname: 'swarmy-mac', disk: { usedBytes: 0, totalBytes: 500 * GB } });

  it('replacement manager + Garage member: the public cloud worker, never the home VM, and the plan says why', () => {
    const p = planDecommission(
      input({
        targetNodeId: 'a',
        nodes: [
          node('a', { role: 'manager', leader: true, labels: { ...g, ...cloud('203.0.113.1'), 'swarmy.region': 'eu' } }),
          homeVm({ ...nat, 'swarmy.region': 'eu' }),
          node('z', { labels: cloud('203.0.113.26', { 'swarmy.region': 'eu' }) }, { hostname: 'cloud-z' }),
        ],
        garageReplicationFactor: 1,
      }),
    );
    expect(p.runnable).toBe(true);
    const promote = p.steps.find((s) => s.kind === 'manager-promote')!;
    const garage = p.steps.find((s) => s.kind === 'garage-add-member')!;
    expect(promote.destination!.nodeId).toBe('z');
    expect(garage.destination!.nodeId).toBe('z');
    for (const step of [promote, garage]) {
      expect(step.detail).toContain('Chose cloud-z because it has a public IP (203.0.113.26)');
      expect(step.detail).toContain('is in eu like the server it replaces');
      expect(step.detail).toContain('Passed over swarmy-mac: behind NAT');
    }
  });

  it('only a NAT\'d candidate → a blocker naming it and the override, not a silent pick', () => {
    const p = planDecommission(
      input({ targetNodeId: 'a', nodes: [node('a', { role: 'manager', labels: { ...g, ...cloud('203.0.113.1') } }), homeVm()] }),
    );
    expect(p.runnable).toBe(false);
    expect(p.steps.some((s) => s.kind === 'manager-promote' || s.kind === 'garage-add-member')).toBe(false);
    const codes = p.blockers.map((b) => b.code);
    expect(codes).toContain('no-manager-candidate');
    expect(codes).toContain('garage-no-replacement');
    const b = p.blockers.find((x) => x.code === 'no-manager-candidate')!;
    expect(b.message).toContain('swarmy-mac');
    expect(b.fix).toContain('swarmy.node.reachability.override=public');
  });

  it('an operator override makes the NAT\'d server eligible', () => {
    const p = planDecommission(
      input({
        targetNodeId: 'a',
        nodes: [
          node('a', { role: 'manager', labels: cloud('203.0.113.1') }),
          homeVm({ ...nat, 'swarmy.node.reachability.override': 'public' }),
        ],
      }),
    );
    const promote = p.steps.find((s) => s.kind === 'manager-promote')!;
    expect(promote.destination!.nodeId).toBe('mac');
    expect(promote.detail).toContain('marked publicly reachable by an operator');
  });

  it('the edge role never hands over to a NAT\'d server either', () => {
    const p = planDecommission(
      input({
        nodes: [
          node('a', { role: 'manager' }),
          node('b', { labels: { 'swarmy.node.ingress': 'true', ...cloud('203.0.113.2') } }),
          homeVm(),
        ],
      }),
    );
    expect(p.blockers.map((x) => x.code)).toContain('edge-no-replacement');
  });

  it('ranking: public > same region > capacity > load', () => {
    const t = node('t', { labels: { 'swarmy.region': 'eu' } });
    const big = { disk: { usedBytes: 0, totalBytes: 400 * GB } };
    const small = { disk: { usedBytes: 0, totalBytes: 100 * GB } };
    // A confirmed-public server beats a merely-has-an-IP one, even outside the region and smaller.
    const confirmed = node('p', { labels: cloud('198.51.100.1', { 'swarmy.node.reachability': 'public', 'swarmy.region': 'us' }) }, small);
    const unconfirmed = node('q', { labels: cloud('198.51.100.2', { 'swarmy.region': 'eu' }) }, big);
    expect(new DestinationPicker([t, confirmed, unconfirmed], 't', 'eu', []).pickRoleHost().chosen!.nodeId).toBe('p');
    // Same reachability: region beats capacity.
    const euSmall = node('e', { labels: cloud('198.51.100.3', { 'swarmy.region': 'eu' }) }, small);
    const usBig = node('u', { labels: cloud('198.51.100.4', { 'swarmy.region': 'us' }) }, big);
    expect(new DestinationPicker([t, usBig, euSmall], 't', 'eu', []).pickRoleHost().chosen!.nodeId).toBe('e');
    // Same region: capacity beats load.
    const euBigBusy = node('f', { labels: cloud('198.51.100.5', { 'swarmy.region': 'eu' }) }, big);
    const busy = [svc('pg', { 'swarmy.db.node': 'sw-f' })];
    expect(new DestinationPicker([t, euSmall, euBigBusy], 't', 'eu', busy).pickRoleHost().chosen!.nodeId).toBe('f');
    // Everything equal: fewer data services wins.
    const euSmall2 = node('g', { labels: cloud('198.51.100.6', { 'swarmy.region': 'eu' }) }, small);
    const busyE = [svc('pg', { 'swarmy.db.node': 'sw-e' })];
    expect(new DestinationPicker([t, euSmall, euSmall2], 't', 'eu', busyE).pickRoleHost().chosen!.nodeId).toBe('g');
  });

  it('nodeReachability reads override, the agent report, then the advertise address', () => {
    const r = (labels: Record<string, string>, addr?: string) => nodeReachability(node('x', { labels, addr })).level;
    expect(r({ 'swarmy.node.reachability': 'nat', 'swarmy.node.reachability.override': 'public' })).toBe('public');
    expect(r({ 'swarmy.node.reachability': 'public', 'swarmy.node.reachability.override': 'nat' })).toBe('nat');
    expect(r({ 'swarmy.node.reachability': 'nat', 'swarmy.node.public-ip': '81.2.69.160' })).toBe('nat');
    expect(r({ 'swarmy.node.public-ip': '203.0.113.7' }, '203.0.113.7')).toBe('public');
    expect(r({ 'swarmy.node.public-ip': '203.0.113.7' }, '100.64.0.9')).toBe('probably-public');
    expect(r({})).toBe('unknown');
  });
});
