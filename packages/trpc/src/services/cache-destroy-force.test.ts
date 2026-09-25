import { describe, expect, it } from 'bun:test';
import { attachedToCache, cachePasswordSecretName, destroyCache } from './cache.service';

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
