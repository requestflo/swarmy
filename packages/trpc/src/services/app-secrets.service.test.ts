import { describe, expect, it, mock } from 'bun:test';
import { toServiceCreateOptions } from '@swarmy/core/docker';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { SECRET_ENV_VAR, wrapSecretEnv } from '@swarmy/core';
import type { OrgContext } from '../context';

process.env.SWARMY_SECRET_KEY ??= 'k'.repeat(64);

// The ABAC seam is exercised in its own suite; here it is a recording stub so a
// reveal can be permitted or denied deterministically.
const authorizeCalls: { action: string; resource: unknown }[] = [];
let denyReveal = false;
// Keep the real module's other exports (evaluateAccess, …): modules in the
// service graph import them at load, and a partial mock fails the whole file.
const realAbac = await import('../abac');
mock.module('../abac', () => ({
  ...realAbac,
  authorize: async (_ctx: unknown, action: string, resource: unknown) => {
    authorizeCalls.push({ action, resource });
    if (denyReveal) throw new Error('not permitted: secrets.read');
    return { action, decision: 'permit', policyId: null };
  },
}));

const { createService, getServiceDetail, updateService } = await import('./service.service');
const { listSecretVars, removeSecretVar, revealSecretVar, setSecretVar } = await import('./app-secrets.service');

const V1 = 'pa55-FIRST-value\n';
const V2 = 'pa55-SECOND-value';
const VALUES = [V1, V2, V1.trim()];
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * A tiny stateful swarm: `secret.create` stores the (base64) data like Docker
 * would; `service.deploy` runs the agent's wrap and "stores" the rendered body,
 * which `service.inspect` returns and the inventory reflects — so each test
 * step reads back what the previous one deployed.
 */
function fakeSwarm() {
  const secrets: { name: string; createdAt: number; labels: Record<string, string>; dataB64: string }[] = [];
  let live: ReturnType<typeof toServiceCreateOptions> | null = null;
  const dispatched: { command: string; payload: Record<string, unknown> }[] = [];
  const audits: unknown[] = [];
  let clock = 1_000;

  const info = (): SwarmServiceInfo[] => {
    if (!live) return [];
    const cs = (live.TaskTemplate as { ContainerSpec: { Env?: string[]; Secrets?: { SecretName: string }[] } })
      .ContainerSpec;
    return [
      {
        id: 'svc-web',
        name: live.Name!,
        image: 'web:1',
        mode: 'replicated',
        desiredReplicas: 1,
        runningReplicas: 1,
        createdAt: 0,
        updatedAt: clock,
        labels: (live.Labels as Record<string, string>) ?? {},
        networks: [],
        env: cs.Env ?? [],
        ports: [],
        secrets: (cs.Secrets ?? []).map((s) => s.SecretName),
        configs: [],
      } as SwarmServiceInfo,
    ];
  };

  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
    membership: { role: 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
    db: {
      guardrailConfig: { findUnique: async () => null },
      exposureConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      webhookEndpoint: { findMany: async () => [] },
      auditLog: {
        create: async ({ data }: { data: unknown }) => {
          audits.push(data);
          return data;
        },
      },
    },
    hub: {
      liveInventory: () => ({
        services: info(),
        containers: live ? [{ id: 'c1', serviceId: 'svc-web', state: 'running', labels: {} }] : [],
      }),
      isOnline: () => true,
      managerNode: () => 'node1',
      onlineNodeIds: () => ['node1'],
      swarmNodeIdFor: () => undefined,
      latestContainers: () => [
        { id: 'c1', serviceId: 'svc-web', state: 'running', labels: {} },
      ],
      dispatch: async (_node: string, command: string, payload: Record<string, unknown>) => {
        dispatched.push({ command, payload });
        clock += 1_000;
        switch (command) {
          case 'secret.list':
            return { secrets: secrets.map(({ dataB64: _d, ...s }) => s) };
          case 'secret.create':
            secrets.push({
              name: payload.name as string,
              createdAt: clock,
              labels: payload.labels as Record<string, string>,
              dataB64: payload.dataB64 as string,
            });
            return { id: `s${secrets.length}`, name: payload.name };
          case 'service.deploy': {
            const spec = payload.spec as ServiceSpec;
            live = toServiceCreateOptions(wrapSecretEnv(spec, { entrypoint: ['/entry'], cmd: ['serve'] }));
            return { serviceId: 'svc-web', created: false };
          }
          case 'service.inspect':
            return { inspect: { ID: 'svc-web', Version: { Index: 1 }, Spec: live } };
          case 'exec': {
            const path = (payload.cmd as string[])[1]!;
            const key = path.split('/').pop()!;
            const cs = (live!.TaskTemplate as { ContainerSpec: { Secrets?: { SecretName: string; File: { Name: string } }[] } })
              .ContainerSpec;
            const ref = cs.Secrets?.find((r) => r.File.Name === key);
            const data = secrets.find((s) => s.name === ref?.SecretName)?.dataB64;
            return data ? { exitCode: 0, output: Buffer.from(data, 'base64').toString('utf8') } : { exitCode: 1, output: '' };
          }
          default:
            return {};
        }
      },
    },
  } as unknown as OrgContext;

  const lastDeploy = (): ServiceSpec => {
    const d = dispatched.filter((x) => x.command === 'service.deploy');
    return d[d.length - 1]!.payload.spec as ServiceSpec;
  };
  const creates = () => dispatched.filter((x) => x.command === 'secret.create');
  /** Every value may ONLY ever appear as `secret.create`'s dataB64 — nowhere else. */
  const expectNoLeak = () => {
    const outside = [
      ...dispatched.map((d) =>
        d.command === 'secret.create' ? { ...d, payload: { ...d.payload, dataB64: '<redacted>' } } : d,
      ),
      live,
      audits,
    ];
    const json = JSON.stringify(outside);
    for (const v of VALUES) {
      expect(json).not.toContain(JSON.stringify(v).slice(1, -1));
      expect(json).not.toContain(b64(v));
    }
  };
  return { ctx, secrets, dispatched, audits, lastDeploy, creates, expectNoLeak, live: () => live };
}

describe('secret app variables — create → keep → rotate → dedupe → remove', () => {
  const s = fakeSwarm();

  it('create: the value becomes a Docker secret; the spec only names it', async () => {
    await createService(s.ctx, {
      name: 'shop_web',
      image: 'web:1',
      replicas: 1,
      command: [],
      env: [
        { key: 'LOG', value: 'info' },
        { key: 'DB_PASSWORD', value: V1, secret: true },
        { key: 'TLS_KEY', value: V1.trim(), secret: true, delivery: 'file' },
      ],
      ports: [],
      volumes: [],
      networks: [],
      constraints: [],
      project: 'shop',
    });
    expect(s.creates().map((c) => [c.payload.name, c.payload.dataB64])).toEqual([
      ['shop_web_DB_PASSWORD_v1', b64(V1)],
      ['shop_web_TLS_KEY_v1', b64(V1.trim())],
    ]);
    const spec = s.lastDeploy();
    expect(spec.secretEnv).toEqual(['DB_PASSWORD']);
    expect(spec.env).toEqual({ LOG: 'info', TLS_KEY_FILE: '/run/secrets/TLS_KEY' });
    expect(spec.secrets).toEqual([
      { source: 'shop_web_DB_PASSWORD_v1', target: 'DB_PASSWORD', mode: 0o444 },
      { source: 'shop_web_TLS_KEY_v1', target: 'TLS_KEY', mode: 0o444 },
    ]);
    const labels = s.secrets[0]!.labels;
    expect(labels['swarmy.appsecret.by']).toBe('Ada Lovelace');
    expect(labels['swarmy.appsecret.digest']).toMatch(/^[A-Za-z0-9_-]{32}$/);
    s.expectNoLeak();
  });

  it('detail + metadata: names and "set by/at", never a value', async () => {
    const detail = getServiceDetail(s.ctx, 'svc-web');
    expect(detail.secretKeys).toEqual({ DB_PASSWORD: 'env', TLS_KEY: 'file' });
    expect(detail.env[SECRET_ENV_VAR]).toBeUndefined();
    const vars = await listSecretVars(s.ctx, 'svc-web');
    expect(vars.map((v) => [v.key, v.delivery, v.version, v.updatedBy])).toEqual([
      ['DB_PASSWORD', 'env', 1, 'Ada Lovelace'],
      ['TLS_KEY', 'file', 1, 'Ada Lovelace'],
    ]);
    expect(JSON.stringify(vars)).not.toContain('pa55');
  });

  it('an old client sending only plain env keeps the secrets', async () => {
    const before = s.creates().length;
    await updateService(s.ctx, { id: 'svc-web', env: [{ key: 'LOG', value: 'debug' }] });
    expect(s.creates().length).toBe(before);
    const spec = s.lastDeploy();
    expect(spec.env).toEqual({ LOG: 'debug', TLS_KEY_FILE: '/run/secrets/TLS_KEY' });
    expect(spec.secretEnv).toEqual(['DB_PASSWORD']);
    expect(spec.command).toBeUndefined(); // the shim never leaks back in as "the command"
  });

  it('empty value keeps; a new value rotates to v2 at the same path; an unchanged value does not', async () => {
    await updateService(s.ctx, {
      id: 'svc-web',
      env: [
        { key: 'LOG', value: 'debug' },
        { key: 'DB_PASSWORD', value: '', secret: true },
      ],
    });
    expect(s.creates()).toHaveLength(2);

    await updateService(s.ctx, {
      id: 'svc-web',
      env: [
        { key: 'LOG', value: 'debug' },
        { key: 'DB_PASSWORD', value: V2, secret: true },
      ],
    });
    expect(s.creates().map((c) => c.payload.name)).toContain('shop_web_DB_PASSWORD_v2');
    const spec = s.lastDeploy();
    expect(spec.secrets).toContainEqual({ source: 'shop_web_DB_PASSWORD_v2', target: 'DB_PASSWORD', mode: 0o444 });
    expect(spec.secrets?.some((r) => r.source === 'shop_web_DB_PASSWORD_v1')).toBe(false);

    const n = s.creates().length;
    await setSecretVar(s.ctx, { id: 'svc-web', key: 'DB_PASSWORD', value: V2, delivery: 'env' });
    expect(s.creates().length).toBe(n); // same keyed digest → no churn
    s.expectNoLeak();
  });

  it('reveal is gated on secrets.read, audited, and reads the running task', async () => {
    authorizeCalls.length = 0;
    const r = await revealSecretVar(s.ctx, { id: 'svc-web', key: 'DB_PASSWORD' });
    expect(r).toEqual({ key: 'DB_PASSWORD', version: 2, value: V2 });
    expect(authorizeCalls.map((c) => c.action)).toEqual(['secrets.read']);
    const exec = s.dispatched.filter((d) => d.command === 'exec').pop()!;
    expect(exec.payload.cmd).toEqual(['cat', '/run/secrets/DB_PASSWORD']);
    const audit = s.audits.filter((a) => (a as { action: string }).action === 'secrets.reveal').pop() as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata).toEqual({ service: 'shop_web', key: 'DB_PASSWORD', version: 2, ok: true });

    denyReveal = true;
    const execs = s.dispatched.filter((d) => d.command === 'exec').length;
    await expect(revealSecretVar(s.ctx, { id: 'svc-web', key: 'DB_PASSWORD' })).rejects.toThrow(/secrets.read/);
    expect(s.dispatched.filter((d) => d.command === 'exec').length).toBe(execs); // never read on deny
    denyReveal = false;
  });

  it('demote (sent as plain) and explicit remove drop the mount; nothing else changes', async () => {
    await updateService(s.ctx, {
      id: 'svc-web',
      env: [{ key: 'LOG', value: 'debug' }],
      removeSecretKeys: ['TLS_KEY'],
    });
    let spec = s.lastDeploy();
    expect(spec.env).toEqual({ LOG: 'debug' });
    expect(spec.secrets?.map((r) => r.target)).toEqual(['DB_PASSWORD']);

    await removeSecretVar(s.ctx, { id: 'svc-web', key: 'DB_PASSWORD' });
    spec = s.lastDeploy();
    expect(spec.secrets).toBeUndefined();
    expect(spec.secretEnv).toBeUndefined();
    expect(s.live()!.TaskTemplate).toBeDefined();
    const cs = (s.live()!.TaskTemplate as { ContainerSpec: { Command?: string[]; Args?: string[] } }).ContainerSpec;
    expect(cs.Command).toBeUndefined(); // unwrapped once no env secret remains
    expect(cs.Args).toBeUndefined();
    s.expectNoLeak();
  });
});
