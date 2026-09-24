import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, ServiceSpec, SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import {
  caddyEdgeSpec,
  defaultEdgeImage,
  deployWithModeSwap,
  EDGE_PLACEMENT_CONSTRAINT,
} from './ingress-controller';
import { getConfig, reconcileIngressOrg, setTopology } from './ingress.service';
import { OBJECT_STORAGE_REQUIRED_MESSAGE, buildLegacyPurgeRunOnce, certStorageFor } from './ingress-certs';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

/** The secret access key the fake Garage mints — must never reach a render. */
const MINTED_SECRET = 'garage-secret-access-key-DO-NOT-LEAK';

/**
 * Geo-edge topology swap: swarm can't flip replicated↔global in place
 * (`HTTP 501 service mode change is not allowed`), so the swap is remove +
 * create with the cert volumes kept, and the setting persists only on success.
 */

const EDGE_NAME = 'swarmy-ingress-caddy';

interface Sent {
  nodeId: string;
  cmd: string;
  payload: any;
}

function svc(over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo {
  return {
    id: 'svc1',
    name: EDGE_NAME,
    image: 'caddy:2-alpine',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: {},
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...over,
  };
}

function edgeTask(id: string): ContainerInfo {
  return {
    id,
    name: `${EDGE_NAME}.x.${id}`,
    image: 'caddy:2-alpine',
    state: 'running',
    status: 'Up',
    createdAt: 0,
    ports: [],
    labels: { 'com.docker.swarm.service.name': EDGE_NAME },
  };
}

function node(over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo {
  return {
    swarmNodeId: 'sw1',
    hostname: 'lon-a',
    role: 'manager',
    availability: 'active',
    status: 'ready',
    leader: true,
    labels: { 'swarmy.node.ingress': 'true' },
    ...over,
  };
}

/**
 * Stateful fake: `service.remove`/`service.deploy` mutate the live inventory
 * the way Docker would — including REFUSING an in-place mode change.
 */
function world(opts: {
  services?: SwarmServiceInfo[];
  settings?: Record<string, unknown>;
  nodes?: SwarmNodeInfo[];
  containers?: Record<string, ContainerInfo[]>;
  failDeployOf?: 'global' | 'replicated';
  /** Inventory lies: reports this mode while Docker holds the other. */
  staleMode?: 'replicated' | 'global';
  /** swarmy object storage (Garage) on? Default true. */
  objectStorage?: boolean;
  /** Buckets Garage already holds (alias → id). */
  buckets?: Record<string, string>;
  /** Docker secrets already in the swarm. */
  secrets?: string[];
}) {
  const sent: Sent[] = [];
  const garage: Array<{ method: string; url: string; body?: string }> = [];
  const buckets = new Map(Object.entries(opts.buckets ?? {}));
  const secrets = new Set(opts.secrets ?? []);
  let keySeq = 0;
  const garageReply = (method: string, url: string, body?: string): string => {
    garage.push({ method, url, body });
    const path = url.replace(/^.*\/v1/, '');
    if (method === 'GET' && path === '/bucket?list') {
      return JSON.stringify([...buckets].map(([alias, id]) => ({ id, globalAliases: [alias] })));
    }
    if (method === 'POST' && path === '/bucket') {
      const alias = JSON.parse(body ?? '{}').globalAlias as string;
      const id = `bkt-${alias}`;
      buckets.set(alias, id);
      return JSON.stringify({ id, globalAliases: [alias] });
    }
    if (method === 'POST' && path === '/key') {
      keySeq += 1;
      return JSON.stringify({
        accessKeyId: `GK00000000000${keySeq}`,
        secretAccessKey: MINTED_SECRET,
        name: JSON.parse(body ?? '{}').name,
      });
    }
    return '{}';
  };
  const services = [...(opts.services ?? [])];
  const truthMode = new Map(services.map((s) => [s.name, s.mode]));
  const row = { driver: 'CADDY', enabled: true, settings: { ...(opts.settings ?? {}) } as any, updatedAt: new Date(0) };
  const updates: unknown[] = [];
  const containers = opts.containers ?? { m1: [] };
  const db = {
    observabilityConfig: { findUnique: async () => null },
    ingressConfig: {
      upsert: async () => row,
      update: async (a: { data: { settings: unknown } }) => {
        updates.push(a.data.settings);
        row.settings = a.data.settings;
        return row;
      },
    },
    node: { findMany: async () => Object.keys(containers).map((id) => ({ id })) },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async () => ({}) },
    storageCluster: {
      findUnique: async () =>
        opts.objectStorage === false
          ? null
          : {
              orgId: 'org_topo',
              enabled: true,
              driver: 'GARAGE',
              region: 'garage',
              adminTokenRef: encryptSecret('admin-token'),
              memberNodeIds: ['m1'],
            },
    },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    managerNodes: () => ['m1'],
    nodeInventory: () => opts.nodes ?? [node()],
    swarmNodeIdFor: () => undefined,
    nodeInfoFor: (id: string) => ({ hostname: `host-${id}`, labels: {} }),
    liveInventory: () => ({
      services: services.map((s) => (opts.staleMode ? { ...s, mode: opts.staleMode } : s)),
      containers: [],
    }),
    latestContainers: (id: string) => containers[id] ?? [],
    dispatch: async (nodeId: string, cmd: string, payload: any) => {
      sent.push({ nodeId, cmd, payload });
      if (cmd === 'container.runOnce' && payload.env?.PURGE_PREFIX) return { exitCode: 0, output: '' };
      if (cmd === 'container.runOnce') {
        const out = garageReply(payload.env.GARAGE_METHOD, payload.env.GARAGE_URL, payload.env.GARAGE_BODY);
        return { exitCode: 0, output: `__SWARMY_STATUS__:200\n${out}` };
      }
      if (cmd === 'secret.list') return { secrets: [...secrets].map((name) => ({ id: name, name })) };
      if (cmd === 'secret.create') secrets.add(payload.name);
      if (cmd === 'service.remove') {
        const i = services.findIndex((s) => s.name === payload.service);
        if (i < 0) throw new Error(`service ${payload.service} not found`);
        services.splice(i, 1);
        truthMode.delete(payload.service);
      }
      if (cmd === 'service.deploy') {
        const spec = payload.spec as ServiceSpec;
        const mode = spec.mode && 'global' in spec.mode ? 'global' : 'replicated';
        if (opts.failDeployOf === mode) throw new Error('image pull failed');
        const live = truthMode.get(spec.name);
        if (live && live !== mode) {
          throw new Error('(HTTP code 501) unexpected - service mode change is not allowed');
        }
        truthMode.set(spec.name, mode);
        const i = services.findIndex((s) => s.name === spec.name);
        const next = svc({
          name: spec.name,
          mode,
          labels: spec.labels ?? {},
          secrets: (spec.secrets ?? []).map((x) => x.source),
        });
        if (i >= 0) services[i] = next;
        else services.push(next);
      }
      return {};
    },
  };
  const ctx = { db, hub, activeOrgId: 'org_topo', user: { id: 'u1' } } as unknown as OrgContext;
  return { ctx, sent, row, updates, services, garage, secrets, deps: { db, hub, auth: {} } as never };
}

const cmds = (sent: Sent[]) => sent.map((s) => s.cmd).filter((c) => c.startsWith('service.'));

describe('caddyEdgeSpec — edge-per-node golden', () => {
  const spec = caddyEdgeSpec({ network: 'swarmy', image: 'caddy:2-alpine' });

  it('runs GLOBAL on ingress-labelled nodes', () => {
    expect(spec.mode).toEqual({ global: {} });
    expect(spec.placement?.constraints).toEqual([EDGE_PLACEMENT_CONSTRAINT]);
    expect(EDGE_PLACEMENT_CONSTRAINT).toBe('node.labels.swarmy.node.ingress == true');
  });

  it('joins swarmy (apps, Garage) + the PRIVATE swarmy-control (dashboard vhost upstream) on any org network', () => {
    expect(spec.networks).toEqual(['swarmy', 'swarmy-control']);
    expect(caddyEdgeSpec({ network: 'edge', image: 'x' }).networks).toEqual(['edge', 'swarmy', 'swarmy-control']);
  });

  it('has NO host bind mount — config is written inside the task — and keeps the cert volumes', () => {
    expect(spec.mounts?.some((m) => m.type === 'bind')).toBe(false);
    expect(spec.mounts).toEqual([
      { type: 'volume', source: 'swarmy-ingress-caddy-data', target: '/data' },
      { type: 'volume', source: 'swarmy-ingress-caddy-config', target: '/config' },
    ]);
  });

  it('boots a loopback-admin base config and resumes the autosave; host-mode 80/443', () => {
    const cmd = spec.command?.join(' ') ?? '';
    expect(cmd).toContain('admin 127.0.0.1:2019');
    expect(cmd).toContain('--resume');
    expect(spec.ports?.every((p) => p.mode === 'host')).toBe(true);
    expect(spec.ports?.map((p) => p.published)).toEqual([80, 443, 443]);
  });
});

describe('deployWithModeSwap', () => {
  it('replicated → global: removes the live service (by `service`, not `name`) then creates', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    const swapped = await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }));
    expect(swapped).toBe(true);
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.sent[0]!.payload).toEqual({ service: EDGE_NAME });
    expect(w.services[0]!.mode).toBe('global');
  });

  it('same mode is a plain in-place update (no remove)', async () => {
    const w = world({ services: [svc({ mode: 'global' })] });
    expect(await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }))).toBe(false);
    expect(cmds(w.sent)).toEqual(['service.deploy']);
  });

  it('stale inventory: Docker refuses the mode change → remove + create once', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })], staleMode: 'global' });
    expect(await deployWithModeSwap(w.ctx, 'm1', caddyEdgeSpec({ network: 'swarmy', image: 'i' }))).toBe(true);
    expect(cmds(w.sent)).toEqual(['service.deploy', 'service.remove', 'service.deploy']);
  });
});

describe('setTopology', () => {
  it('controller → edge-per-node swaps the service and persists only after the deploy', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    const view = await setTopology(w.ctx, 'edge-per-node');
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    const deployed = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(deployed.mode).toEqual({ global: {} });
    // Volumes are named volumes carried by the new spec — never removed.
    expect(deployed.mounts?.map((m) => m.source)).toEqual([
      'swarmy-ingress-caddy-data',
      'swarmy-ingress-caddy-config',
    ]);
    expect(w.sent.some((s) => s.cmd.startsWith('volume.'))).toBe(false);
    expect(w.row.settings.topology).toBe('edge-per-node');
    expect(view.topology).toBe('edge-per-node');
  });

  it('edge-per-node → controller swaps back', async () => {
    const w = world({ services: [svc({ mode: 'global' })], settings: { topology: 'edge-per-node' } });
    await setTopology(w.ctx, 'controller');
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.services[0]!.mode).toBe('replicated');
    expect(w.row.settings.topology).toBe('controller');
  });

  it('a failed deploy does NOT persist the setting and restores the previous topology', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })], failDeployOf: 'global' });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow();
    // Only the cert-store coordinates were persisted (so a retry never re-mints
    // a key) — never the topology.
    expect(w.updates.some((u) => (u as { topology?: string }).topology)).toBe(false);
    expect(w.row.settings.topology).toBeUndefined();
    // removed, failed create, rolled back to the replicated controller
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy', 'service.deploy']);
    expect(w.services.map((s) => s.mode)).toEqual(['replicated']);
  });

  it('refuses edge-per-node when no node is ingress-labelled — nothing touched', async () => {
    const w = world({ services: [svc()], nodes: [node({ labels: {} })] });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow(/ingress node/);
    expect(cmds(w.sent)).toEqual([]);
    expect(w.updates).toEqual([]);
  });

  it('refuses when the config would not validate under the new topology (shared certs + stock image)', async () => {
    const w = world({ services: [svc()], settings: { controllerImage: 'caddy:2-alpine' } });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow(/certmagic-s3/);
    expect(cmds(w.sent)).toEqual([]);
    expect(w.row.settings.topology).toBeUndefined();
  });
});

describe('setTopology — shared certificates in swarmy object storage', () => {
  it('refuses edge-per-node while object storage is off — nothing touched', async () => {
    const w = world({ services: [svc()], objectStorage: false });
    await expect(setTopology(w.ctx, 'edge-per-node')).rejects.toThrow(OBJECT_STORAGE_REQUIRED_MESSAGE);
    expect(w.sent).toEqual([]);
    expect(w.updates).toEqual([]);
  });

  it('provisions bucket swarmy-edge-certs + a read/write key + a Docker secret, and mounts it on the edge', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    const view = await setTopology(w.ctx, 'edge-per-node');

    // Garage: list → create bucket → mint key → grant read+write (never owner).
    expect(w.garage.map((g) => `${g.method} ${g.url.replace(/^.*\/v1/, '')}`)).toEqual([
      'GET /bucket?list',
      'POST /bucket',
      'POST /key',
      'POST /bucket/allow',
    ]);
    expect(JSON.parse(w.garage[1]!.body!)).toEqual({ globalAlias: 'swarmy-edge-certs' });
    expect(JSON.parse(w.garage[3]!.body!)).toEqual({
      bucketId: 'bkt-swarmy-edge-certs',
      accessKeyId: 'GK000000000001',
      permissions: { read: true, write: true, owner: false },
    });

    // The credential lands ONLY in a Docker secret (AWS shared-credentials INI).
    const created = w.sent.find((s) => s.cmd === 'secret.create' && s.payload.name.startsWith('swarmy-edge-certs-s3-'))!;
    expect(created.payload.name).toBe('swarmy-edge-certs-s3-gk000000000001');
    const ini = Buffer.from(created.payload.dataB64, 'base64').toString('utf8');
    expect(ini).toContain('aws_access_key_id = GK000000000001');
    expect(ini).toContain(`aws_secret_access_key = ${MINTED_SECRET}`);

    // Persisted coordinates carry no secret material.
    const persisted = JSON.stringify(w.row.settings);
    expect(persisted).not.toContain(MINTED_SECRET);
    expect(w.row.settings.certStorage).toMatchObject({
      bucket: 'swarmy-edge-certs',
      region: 'garage',
      endpoint: 'http://swarmy-garage:3900',
      accessKeyId: 'GK000000000001',
      secretName: 'swarmy-edge-certs-s3-gk000000000001',
    });

    // The global edge mounts it and points the AWS SDK default chain at it.
    const deployed = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    const encName = w.row.settings.certStorage.encSecretName as string;
    expect(encName).toMatch(/^swarmy-edge-certs-enc-[0-9a-f]{12}$/);
    expect(deployed.secrets).toEqual([
      { source: 'swarmy-edge-certs-s3-gk000000000001', target: 'swarmy-edge-certs-s3', mode: 0o400 },
      { source: encName, target: 'swarmy-edge-certs-enc', mode: 0o400 },
    ]);
    expect(deployed.env).toMatchObject({
      AWS_SHARED_CREDENTIALS_FILE: '/run/secrets/swarmy-edge-certs-s3',
      AWS_EC2_METADATA_DISABLED: 'true',
    });
    expect(JSON.stringify(deployed)).not.toContain(MINTED_SECRET);
    expect(deployed.image).toBe(defaultEdgeImage());

    expect(view.certStorage).toMatchObject({
      mode: 'shared',
      bucket: 'swarmy-edge-certs',
      objectStorageEnabled: true,
      encrypted: true,
    });
  });

  it('seals certificates at rest: a 32-char key lives ONLY in its own Docker secret, imported by the render', async () => {
    const w = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(w.ctx, 'edge-per-node');
    const cs = w.row.settings.certStorage;
    expect(cs.prefix).toMatch(/^caddy-enc\//);
    const encSecret = w.sent.find((s) => s.cmd === 'secret.create' && s.payload.name === cs.encSecretName)!;
    const line = Buffer.from(encSecret.payload.dataB64, 'base64').toString('utf8');
    const key = /^encryption_key ([A-Za-z0-9_-]{32})\n$/.exec(line)?.[1];
    expect(key).toBeDefined();
    // The key is nowhere but that secret: not persisted, not in the edge spec.
    expect(JSON.stringify(w.row.settings)).not.toContain(key!);
    const deployed = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(JSON.stringify(deployed)).not.toContain(key!);
    expect(certStorageFor(cs)).toMatchObject({ encryptionKeyFile: '/run/secrets/swarmy-edge-certs-enc' });
  });

  it('upgrades a legacy plaintext store: keeps the key + credentials secret, adds encryption on a fresh prefix', async () => {
    const first = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(first.ctx, 'edge-per-node');
    const { encSecretName: _drop, ...legacyStore } = first.row.settings.certStorage;
    const legacy = { ...first.row.settings, certStorage: { ...legacyStore, prefix: 'caddy/org_1' } };
    const w = world({
      services: [svc({ mode: 'global' })],
      settings: legacy,
      secrets: [...first.secrets].filter((n: string) => !n.startsWith('swarmy-edge-certs-enc-')),
    });
    await setTopology(w.ctx, 'edge-per-node');
    expect(w.garage).toEqual([]); // no new Garage key
    const minted = w.sent.filter((s) => s.cmd === 'secret.create').map((s) => s.payload.name);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatch(/^swarmy-edge-certs-enc-/);
    expect(w.row.settings.certStorage).toMatchObject({
      accessKeyId: legacyStore.accessKeyId,
      secretName: legacyStore.secretName,
      encSecretName: minted[0],
    });
    expect(w.row.settings.certStorage.prefix).toMatch(/^caddy-enc\//);
  });

  it('is idempotent: a re-run with the secret still present makes zero Garage calls and mints nothing', async () => {
    const first = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(first.ctx, 'edge-per-node');
    const w = world({
      services: [svc({ mode: 'global' })],
      settings: first.row.settings,
      secrets: [...first.secrets],
    });
    await setTopology(w.ctx, 'edge-per-node');
    expect(w.garage).toEqual([]);
    expect(w.sent.some((s) => s.cmd === 'secret.create')).toBe(false);
    expect(w.row.settings.certStorage).toEqual(first.row.settings.certStorage);
    // Same mode ⇒ plain in-place update, secret still mounted.
    expect(cmds(w.sent)).toEqual(['service.deploy']);
    const spec = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(spec.secrets?.[0]?.source).toBe(first.row.settings.certStorage.secretName);
  });

  it('reuses an existing swarmy-edge-certs bucket (found by alias)', async () => {
    const w = world({ services: [svc()], buckets: { 'swarmy-edge-certs': 'bkt-existing' } });
    await setTopology(w.ctx, 'edge-per-node');
    expect(w.garage.some((g) => g.method === 'POST' && g.url.endsWith('/v1/bucket'))).toBe(false);
    expect(w.row.settings.certStorage.bucketId).toBe('bkt-existing');
  });

  it('switching back to the controller keeps the store but renders local file storage', async () => {
    const first = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(first.ctx, 'edge-per-node');
    const w = world({
      services: [svc({ mode: 'global' })],
      settings: first.row.settings,
      secrets: [...first.secrets],
      containers: { m1: [edgeTask('c1')] },
    });
    await setTopology(w.ctx, 'controller');
    expect(w.row.settings.certStorage).toEqual(first.row.settings.certStorage);
    const spec = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(spec.secrets).toBeUndefined();
    const applied = w.sent.find((s) => s.cmd === 'applyIngress');
    const caddyfile = applied?.payload.rendered.localReload?.file?.contents ?? '';
    expect(caddyfile).not.toContain('storage s3');
    const view = await getConfig(w.ctx);
    expect(view.certStorage.mode).toBe('local');
  });
});

describe('reconcileIngressOrg — shared certificate store', () => {
  const app = svc({
    id: 'app1',
    name: 'web',
    labels: {
      'swarmy.ingress.routes': JSON.stringify([{ host: 'app.example.test', port: 80, tls: 'auto' }]),
    },
  });

  it('renders the storage s3 block with NO secret material into every edge', async () => {
    const first = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(first.ctx, 'edge-per-node');
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: first.row.settings,
      secrets: [...first.secrets],
      containers: { lon: [edgeTask('c-lon')], nyc: [edgeTask('c-nyc')] },
    });
    const res = await reconcileIngressOrg(w.deps, 'org_certs_render');
    expect(res.applied).toBe(true);
    const applies = w.sent.filter((s) => s.cmd === 'applyIngress');
    expect(applies).toHaveLength(2);
    for (const a of applies) {
      const caddyfile = a.payload.rendered.localReload.file.contents as string;
      expect(caddyfile).toContain('storage s3 {');
      expect(caddyfile).toContain('endpoint http://swarmy-garage:3900');
      expect(caddyfile).toContain('bucket swarmy-edge-certs');
      expect(caddyfile).toContain('region garage');
      expect(caddyfile).toContain('use_path_style true');
      expect(caddyfile).not.toContain(MINTED_SECRET);
      expect(caddyfile).not.toMatch(/access_key|secret_key|GK0000/);
      expect(JSON.stringify(a.payload)).not.toContain(MINTED_SECRET);
    }
  });

  it('adopts an org already on edge-per-node without a store (zero setup), then redeploys the edge', async () => {
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: { topology: 'edge-per-node' },
      containers: { lon: [edgeTask('c-lon')] },
    });
    const res = await reconcileIngressOrg(w.deps, 'org_certs_adopt');
    expect(res.signature).toBeNull();
    expect(w.row.settings.certStorage?.bucket).toBe('swarmy-edge-certs');
    const spec = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(spec.secrets?.[0]?.target).toBe('swarmy-edge-certs-s3');
  });

  it('a legacy plaintext store: upgrade tick flags a re-issue; the apply tick restarts the edge ONCE into the sealed prefix', async () => {
    const first = world({ services: [svc({ mode: 'replicated' })] });
    await setTopology(first.ctx, 'edge-per-node');
    const { encSecretName: _e, ...legacyStore } = first.row.settings.certStorage;
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: { ...first.row.settings, certStorage: { ...legacyStore, prefix: 'caddy/org_1' } },
      secrets: [...first.secrets].filter((n: string) => !n.startsWith('swarmy-edge-certs-enc-')),
      containers: { lon: [edgeTask('c-lon')], nyc: [edgeTask('c-nyc')] },
    });
    // Tick 1: upgrade (mint key secret, redeploy with it mounted).
    await reconcileIngressOrg(w.deps, 'org_reissue');
    expect(w.row.settings.certStorage.reissuePending).toBe(true);
    expect(w.sent.some((s) => s.cmd === 'service.restart')).toBe(false);
    // Tick 2: sealed config applied to every edge → one forced restart, flag cleared.
    const res = await reconcileIngressOrg(w.deps, 'org_reissue');
    expect(res.applied).toBe(true);
    const applies = w.sent.filter((s) => s.cmd === 'applyIngress');
    expect(applies.every((a) => (a.payload.rendered.localReload.file.contents as string).includes('import /run/secrets/swarmy-edge-certs-enc'))).toBe(true);
    const restarts = w.sent.filter((s) => s.cmd === 'service.restart');
    expect(restarts.map((r) => r.payload)).toEqual([{ service: 'swarmy-ingress-caddy', forceNewTask: true }]);
    expect(w.row.settings.certStorage.reissuePending).toBe(false);
    expect(w.row.settings.certStorage.legacyPrefix).toBe('caddy/org_1');
    // Tick 3 (edges back on the sealed store): purge the plaintext prefix from
    // Garage with a short-lived key, secrets in env only; no second restart.
    await reconcileIngressOrg(w.deps, 'org_reissue', null);
    expect(w.sent.filter((s) => s.cmd === 'service.restart')).toHaveLength(1);
    const purge = w.sent.find((s) => s.cmd === 'container.runOnce' && s.payload.env?.PURGE_PREFIX);
    expect(purge?.payload.env.PURGE_PREFIX).toBe('caddy/org_1');
    expect(purge?.payload.env.PURGE_BUCKET).toBe('swarmy-edge-certs');
    expect(JSON.stringify(purge?.payload.cmd)).not.toMatch(/GK0|secret/i);
    expect(w.row.settings.certStorage.legacyPrefix).toBeUndefined();
  });

  it('refuses to purge anything but a legacy per-org plaintext prefix', () => {
    const base = { endpoint: 'http://g:3900', region: 'garage', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'swarmy-edge-certs' };
    expect(() => buildLegacyPurgeRunOnce({ ...base, prefix: 'caddy-enc/org_1' })).toThrow();
    expect(() => buildLegacyPurgeRunOnce({ ...base, prefix: '' })).toThrow();
    expect(() => buildLegacyPurgeRunOnce({ ...base, prefix: 'caddy/../x' })).toThrow();
    expect(buildLegacyPurgeRunOnce({ ...base, prefix: 'caddy/org_1' }).env.PURGE_PREFIX).toBe('caddy/org_1');
  });

  it('waits quietly (no Garage call, no error) while object storage is off', async () => {
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: { topology: 'edge-per-node' },
      containers: { lon: [edgeTask('c-lon')] },
      objectStorage: false,
    });
    const res = await reconcileIngressOrg(w.deps, 'org_certs_off');
    expect(res.error).toBeUndefined();
    expect(w.garage).toEqual([]);
    expect(w.row.settings.certStorage).toBeUndefined();
  });
});

describe('default Caddy image', () => {
  it('is swarmy’s Caddy build on GHCR for both topologies', () => {
    const prev = process.env.SWARMY_CADDY_EDGE_IMAGE;
    delete process.env.SWARMY_CADDY_EDGE_IMAGE;
    try {
      expect(defaultEdgeImage()).toBe('ghcr.io/requestflo/caddy-swarmy:latest');
    } finally {
      if (prev !== undefined) process.env.SWARMY_CADDY_EDGE_IMAGE = prev;
    }
  });

  it('SWARMY_CADDY_EDGE_IMAGE overrides it', () => {
    const prev = process.env.SWARMY_CADDY_EDGE_IMAGE;
    process.env.SWARMY_CADDY_EDGE_IMAGE = 'registry.example.test/caddy:1';
    try {
      expect(defaultEdgeImage()).toBe('registry.example.test/caddy:1');
    } finally {
      if (prev === undefined) delete process.env.SWARMY_CADDY_EDGE_IMAGE;
      else process.env.SWARMY_CADDY_EDGE_IMAGE = prev;
    }
  });

  it('the controller topology deploys it when no image is configured', async () => {
    const w = world({ services: [svc({ mode: 'global' })], settings: { topology: 'edge-per-node' } });
    await setTopology(w.ctx, 'controller');
    const spec = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(spec.image).toBe(defaultEdgeImage());
  });
});

describe('reconcileIngressOrg — edge-per-node', () => {
  const app = svc({
    id: 'app1',
    name: 'web',
    labels: {
      'swarmy.ingress.routes': JSON.stringify([{ host: 'app.example.test', port: 80, tls: 'auto' }]),
    },
  });

  it('converges a live mode that disagrees with the persisted topology', async () => {
    const w = world({ services: [app, svc({ mode: 'replicated' })], settings: { topology: 'edge-per-node' } });
    const res = await reconcileIngressOrg(w.deps, 'org_topo_drift');
    expect(res.signature).toBeNull();
    expect(cmds(w.sent)).toEqual(['service.remove', 'service.deploy']);
    expect(w.services.find((s) => s.name === EDGE_NAME)!.mode).toBe('global');
  });

  it('exec-delivers the config into EVERY node running an edge task — no host files', async () => {
    const w = world({
      services: [app, svc({ mode: 'global' })],
      settings: { topology: 'edge-per-node' },
      containers: { lon: [edgeTask('c-lon')], nyc: [edgeTask('c-nyc')], worker: [] },
      objectStorage: false,
    });
    const res = await reconcileIngressOrg(w.deps, 'org_topo_fanout');
    expect(res.applied).toBe(true);
    const applies = w.sent.filter((s) => s.cmd === 'applyIngress');
    expect(applies.map((a) => a.nodeId).sort()).toEqual(['lon', 'nyc']);
    for (const a of applies) {
      expect(a.payload.rendered.files).toEqual([]);
      expect(a.payload.rendered.localReload.service).toBe(EDGE_NAME);
      expect(a.payload.rendered.localReload.file.path).toBe('/etc/caddy/Caddyfile');
      expect(a.payload.rendered.localReload.file.contents).toContain('app.example.test');
    }
  });
});
