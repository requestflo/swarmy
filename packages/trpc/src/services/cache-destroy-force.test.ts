import { describe, expect, it } from 'bun:test';
import { carryManagedAttachments } from './attachment-carry';
import { attachedToCache, cachePasswordSecretName, cacheWiringToStrip, destroyCache, provisionCache } from './cache.service';

/** QA-043: a forced destroy detaches attached apps before removing the cluster. */
const base = { mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, ports: [], createdAt: 0, updatedAt: 0, configs: [] };
const secret = cachePasswordSecretName('qa-compose', 'kv');
const primary = {
  ...base,
  id: 'p1',
  name: 'qa-compose_kv-cache',
  image: 'valkey/valkey:8',
  labels: { 'com.docker.stack.namespace': 'qa-compose', 'swarmy.cache.cluster': 'kv', 'swarmy.cache.engine': 'valkey', 'swarmy.cache.role': 'primary' },
  networks: [{ name: 'qa-compose_kv-cache-net', aliases: [] }],
  env: [],
  secrets: [secret],
};
const web = {
  ...base,
  id: 'w1',
  name: 'qa-compose_web',
  image: 'nginx:1',
  labels: { 'com.docker.stack.namespace': 'qa-compose', 'swarmy.cache.inject': 'kv', 'swarmy.cache.inject.var': 'REDIS_URL' },
  networks: [{ name: 'qa-compose_default', aliases: [] }, { name: 'qa-compose_kv-cache-net', aliases: [] }],
  env: [`REDIS_URL=redis://qa-compose_kv-cache:6379`, `REDIS_PASSWORD_FILE=/run/secrets/${secret}`],
  secrets: [secret],
};

describe('cache.destroy {force}', () => {
  it('attachedToCache finds labelled apps and secret holders, never members', () => {
    const stray = { ...web, name: 'other_app', stack: 'other', labels: {}, secrets: [secret] };
    const svc = (s: any) => ({ ...s, stack: s.stack ?? 'qa-compose' });
    expect(attachedToCache([svc(primary), svc(web), svc(stray)], 'qa-compose', 'kv', secret, new Set([primary.name])).map((s) => s.name)).toEqual([
      'qa-compose_web',
      'other_app',
    ]);
  });

  it('detaches the app (env, secret, network, labels) BEFORE removing members and the secret', async () => {
    const calls: Array<{ cmd: string; payload: any }> = [];
    const ctx = {
      activeOrgId: 'org1',
      user: { id: 'u1' },
      db: { auditLog: { create: async ({ data }: any) => data } },
      hub: {
        liveInventory: () => ({ services: [primary, web], containers: [] }),
        managerNode: () => 'n1',
        isOnline: () => true,
        dispatch: async (_n: string, cmd: string, payload: any) => {
          calls.push({ cmd, payload });
          if (cmd === 'service.inspect') {
            return {
              inspect: {
                ID: 'w1',
                Spec: {
                  Name: web.name,
                  Labels: web.labels,
                  Mode: { Replicated: { Replicas: 1 } },
                  TaskTemplate: {
                    ContainerSpec: { Image: web.image, Env: web.env, Secrets: [{ SecretName: secret, File: { Name: secret } }] },
                    Networks: [{ Target: 'qa-compose_default' }, { Target: 'qa-compose_kv-cache-net' }],
                  },
                },
              },
            };
          }
          return {};
        },
      },
    } as never;
    await destroyCache(ctx, { stack: 'qa-compose', cluster: 'kv', force: true });
    const order = calls.map((c) => c.cmd);
    const deploy = calls.find((c) => c.cmd === 'service.deploy')!;
    expect(order.indexOf('service.deploy')).toBeLessThan(order.indexOf('service.remove'));
    expect(order.indexOf('service.remove')).toBeLessThan(order.indexOf('secret.remove'));
    const spec = deploy.payload.spec;
    expect(spec.name).toBe('qa-compose_web');
    expect(spec.env?.REDIS_URL).toBeUndefined();
    expect((spec.secrets ?? []).map((s: any) => s.source)).not.toContain(secret);
    expect(spec.networks).not.toContain('qa-compose_kv-cache-net');
    expect(spec.labels?.['swarmy.cache.inject']).toBeUndefined();
  });
});

// ── QA-043 (reopened): nothing re-injects after a forced destroy ──────────────

/**
 * A tiny stateful swarm: service.deploy is a full-spec replace, service.remove
 * deletes, secret.remove refuses a secret still mounted (Docker's "in use"),
 * secret.create refuses a duplicate. The live inventory reads from it.
 */
function fakeSwarm(initial: any[]) {
  const services = new Map<string, any>(initial.map((s) => [s.name, structuredClone(s)]));
  const secrets = new Set<string>([secret]);
  let clock = 1;
  const inventory = () => [...services.values()].map((s) => ({ ...s, stack: s.labels['com.docker.stack.namespace'] }));
  const dispatch = async (_n: string, cmd: string, payload: any) => {
    if (cmd === 'service.inspect') {
      const s = services.get(payload.service);
      return {
        inspect: {
          ID: s.id,
          Spec: {
            Name: s.name,
            Labels: s.labels,
            Mode: { Replicated: { Replicas: 1 } },
            TaskTemplate: {
              ContainerSpec: { Image: s.image, Env: s.env, Secrets: s.secrets.map((n: string) => ({ SecretName: n, File: { Name: n } })) },
            },
          },
        },
      };
    }
    if (cmd === 'service.deploy') {
      const spec = payload.spec;
      const prev = services.get(spec.name);
      services.set(spec.name, {
        ...base,
        id: prev?.id ?? `id-${spec.name}`,
        name: spec.name,
        image: spec.image,
        updatedAt: clock++,
        labels: spec.labels ?? {},
        env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
        secrets: (spec.secrets ?? []).map((r: any) => r.source),
        networks: (spec.networks ?? []).map((n: string) => ({ name: n, aliases: [] })),
      });
      return {};
    }
    if (cmd === 'service.remove') {
      services.delete(payload.service);
      return {};
    }
    if (cmd === 'secret.remove') {
      const users = [...services.values()].filter((s) => s.secrets.includes(payload.name));
      if (users.length) throw new Error(`secret ${payload.name} is in use by ${users.map((s) => s.name).join(', ')}`);
      secrets.delete(payload.name);
      return {};
    }
    if (cmd === 'secret.create') {
      if (secrets.has(payload.name)) throw new Error(`secret ${payload.name} already exists`);
      secrets.add(payload.name);
      return {};
    }
    return {};
  };
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async ({ data }: any) => data } },
    hub: {
      liveInventory: () => ({ services: inventory(), containers: [] }),
      managerNode: () => 'n1',
      isOnline: () => true,
      nodeInventory: () => [],
      onlineNodeIds: () => ['n1'],
      swarmNodeIdFor: () => undefined,
      nodeInfoFor: () => undefined,
      latestContainers: () => [],
      dispatch,
    },
  } as never;
  return { services, secrets, ctx, inventory };
}

describe('cache.destroy {force} — QA-043 reopened', () => {
  it('cacheWiringToStrip names the inject env, stray env pointing at the cluster, and the labels', () => {
    expect(cacheWiringToStrip(web, 'qa-compose', 'kv')).toEqual({
      env: ['REDIS_URL', 'REDIS_PASSWORD_FILE'],
      labels: ['swarmy.cache.inject', 'swarmy.cache.inject.var'],
    });
    const unlabelled = { labels: {}, env: [`CACHE_PW=/run/secrets/${secret}`, 'OTHER=1'] };
    expect(cacheWiringToStrip(unlabelled, 'qa-compose', 'kv')).toEqual({ env: ['CACHE_PW'], labels: [] });
    // Another cluster's inject labels are not this destroy's to strip.
    expect(cacheWiringToStrip({ labels: { 'swarmy.cache.inject': 'other' }, env: [] }, 'qa-compose', 'kv').labels).toEqual([]);
  });

  it('after a forced destroy, a redeploy leaves the consumer unwired and the same name re-provisions', async () => {
    const swarm = fakeSwarm([primary, web]);
    const staleWeb = structuredClone(web); // what a lagging manager still reports
    await destroyCache(swarm.ctx, { stack: 'qa-compose', cluster: 'kv', force: true });

    // Docker truth: env, label, secret ref and network are all gone, in one deploy.
    const after = swarm.services.get('qa-compose_web');
    expect(after.env.some((e: string) => e.startsWith('REDIS_'))).toBe(false);
    expect(after.labels['swarmy.cache.inject']).toBeUndefined();
    expect(after.labels['swarmy.cache.inject.var']).toBeUndefined();
    expect(after.secrets).not.toContain(secret);
    expect(swarm.secrets.has(secret)).toBe(false);

    // The reconcile that re-injects is a redeploy's attachment carry. Even fed
    // the STALE pre-destroy copy, it carries nothing for a cluster that is gone.
    const compose = { name: 'qa-compose_web', image: 'nginx:1', labels: { 'com.docker.stack.namespace': 'qa-compose' }, networks: ['qa-compose_default'] };
    const carried = carryManagedAttachments(compose as never, { ...staleWeb, stack: 'qa-compose' } as never, {
      liveServices: swarm.inventory() as never,
    });
    expect(carried.env?.REDIS_URL).toBeUndefined();
    expect(carried.labels?.['swarmy.cache.inject']).toBeUndefined();
    expect((carried.secrets ?? []).map((s) => s.source)).not.toContain(secret);

    // Re-provisioning the same name succeeds.
    const res = await provisionCache(swarm.ctx, {
      stack: 'qa-compose',
      name: 'kv',
      engine: 'valkey',
      topology: 'single',
      memoryMb: 256,
      replicas: 0,
      regions: [],
    } as never);
    expect(res.cluster).toBe('kv');
    expect(swarm.services.has('qa-compose_kv-cache')).toBe(true);
  });

  it('re-provision unwires an app still holding the dead cluster wiring, then replaces the secret', async () => {
    // The cluster is gone but web still mounts its secret + carries the labels.
    const swarm = fakeSwarm([web]);
    await provisionCache(swarm.ctx, {
      stack: 'qa-compose',
      name: 'kv',
      engine: 'valkey',
      topology: 'single',
      memoryMb: 256,
      replicas: 0,
      regions: [],
    } as never);
    const w = swarm.services.get('qa-compose_web');
    expect(w.labels['swarmy.cache.inject']).toBeUndefined();
    expect(w.env.some((e: string) => e.startsWith('REDIS_'))).toBe(false);
    expect(w.secrets).not.toContain(secret);
    expect(swarm.secrets.has(secret)).toBe(true); // the new cluster's secret
  });
});
