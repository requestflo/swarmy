import { expect } from 'bun:test';
import { applySecretEnvFileFallback } from '@swarmy/core';
import type { OrgContext } from '../context';

/**
 * A small stateful fake swarm for the managed Postgres credential tests
 * (manageddb.credentials.test.ts, manageddb-pooler.connect.test.ts): services
 * deployed through `service.deploy`, Docker secrets, exec into a member (`cat`
 * of a mounted secret; ALTER ROLE from the mounted file), and a check that no
 * spec ever held a plaintext password. Test-only.
 */

export type Ref = { source: string; target?: string };
export interface Svc {
  id: string;
  name: string;
  image: string;
  mode: 'replicated';
  desiredReplicas: number;
  runningReplicas: number;
  createdAt: number;
  updatedAt: number;
  labels: Record<string, string>;
  env: string[];
  refs: Ref[];
  secretEnv?: string[];
  networks: Array<{ name: string; aliases: string[] }>;
  mounts: Array<{ type: 'volume'; source: string; target: string }>;
  command?: string[];
  gen: number;
}

export const STACK = 'shop';
export const CLUSTER = 'main';

export function world() {
  const services = new Map<string, Svc>();
  const secrets = new Map<string, string>();
  /** Role passwords the fake Postgres holds (set by ALTER ROLE from the mounted file). */
  const roles: Record<string, string> = {};
  const specsSeen: unknown[] = [];
  const execs: string[][] = [];
  let clock = 1;

  const inventory = () =>
    [...services.values()].map((s) => ({ ...s, secrets: s.refs.map((r) => r.source) }));
  const containers = () =>
    [...services.values()].map((s) => ({
      id: `c-${s.name}-${s.gen}`,
      serviceId: s.id,
      state: 'running',
      createdAt: s.gen,
      labels: {},
    }));
  const put = (input: Record<string, any>) => {
    // The agent's deploy-time decision: a shell-less image falls back to _FILE.
    const spec: Record<string, any> = String(input.image).includes('distroless')
      ? applySecretEnvFileFallback(input as never).spec
      : input;
    const prev = services.get(spec.name);
    specsSeen.push(input);
    services.set(spec.name, {
      id: prev?.id ?? `id-${spec.name}`,
      name: spec.name,
      image: spec.image,
      mode: 'replicated',
      desiredReplicas: spec.mode?.replicated?.replicas ?? 1,
      runningReplicas: spec.mode?.replicated?.replicas ?? 1,
      createdAt: 0,
      updatedAt: clock++,
      labels: spec.labels ?? {},
      env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      refs: (spec.secrets ?? []).map((r: Ref) => ({ source: r.source, ...(r.target ? { target: r.target } : {}) })),
      ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}),
      ...(spec.secretEnvFileFallback ? { secretEnvFileFallback: spec.secretEnvFileFallback } : {}),
      networks: (spec.networks ?? []).map((n: string) => ({ name: n, aliases: [] })),
      mounts: (spec.mounts ?? []).filter((m: { type: string }) => m.type === 'volume'),
      ...(spec.command ? { command: spec.command } : {}),
      gen: (prev?.gen ?? 0) + 1, // a redeploy = a new task
    });
  };
  const byContainer = (id: string) => [...services.values()].find((s) => `c-${s.name}-${s.gen}` === id);
  const mounted = (s: Svc, path: string) => {
    const ref = s.refs.find((r) => `/run/secrets/${r.target ?? r.source}` === path);
    return ref ? secrets.get(ref.source) : undefined;
  };

  const dispatch = async (_n: string, cmd: string, payload: any) => {
    switch (cmd) {
      case 'service.inspect': {
        const s = services.get(payload.service)!;
        return {
          inspect: {
            ID: s.id,
            Spec: {
              Name: s.name,
              Labels: s.labels,
              Mode: { Replicated: { Replicas: s.desiredReplicas } },
              TaskTemplate: {
                ContainerSpec: {
                  Image: s.image,
                  Env: s.env,
                  ...(s.command ? { Command: s.command } : {}),
                  Mounts: s.mounts.map((m) => ({ Type: m.type, Source: m.source, Target: m.target })),
                  Secrets: s.refs.map((r) => ({ SecretName: r.source, File: { Name: r.target ?? r.source } })),
                },
              },
            },
          },
        };
      }
      case 'service.deploy':
        put(payload.spec);
        return { serviceId: `id-${payload.spec.name}` };
      case 'service.updateLabels':
        return {};
      case 'secret.create':
        if (secrets.has(payload.name)) throw new Error(`secret ${payload.name} already exists`);
        secrets.set(payload.name, Buffer.from(payload.dataB64, 'base64').toString('utf8'));
        return { id: payload.name, name: payload.name };
      case 'secret.remove': {
        if ([...services.values()].some((s) => s.refs.some((r) => r.source === payload.name))) {
          throw new Error(`secret ${payload.name} is in use`);
        }
        secrets.delete(payload.name);
        return {};
      }
      case 'exec': {
        execs.push(payload.cmd);
        const s = byContainer(payload.target.containerId);
        if (!s) return { exitCode: 1, output: 'no such container' };
        if (payload.cmd[0] === 'cat') {
          const v = mounted(s, payload.cmd[1]);
          return v === undefined ? { exitCode: 1, output: 'No such file' } : { exitCode: 0, output: v };
        }
        const script = String(payload.cmd[2] ?? '');
        const file = /cat (\/run\/secrets\/[^`]+)`/.exec(script)?.[1];
        if (script.includes('ALTER ROLE') && file) {
          const v = mounted(s, file);
          if (v === undefined) return { exitCode: 1, output: 'no secret file' };
          roles.postgres = v;
          roles.repl = v;
          return { exitCode: 0, output: '' };
        }
        return { exitCode: 0, output: '' };
      }
      default:
        return {};
    }
  };

  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role: 'owner', orgId: 'org1' },
    db: { auditLog: { create: async ({ data }: any) => data } },
    hub: {
      liveInventory: () => ({ services: inventory(), containers: containers() }),
      latestContainers: () => containers(),
      onlineNodeIds: () => ['n1'],
      managerNode: () => 'n1',
      isOnline: () => true,
      nodeInventory: () => [{ swarmNodeId: 'swarm-a', hostname: 'a', role: 'manager', status: 'ready', availability: 'active', labels: {} }],
      swarmNodeIdFor: () => 'swarm-a',
      nodeInfoFor: () => undefined,
      dispatch,
    },
  } as unknown as OrgContext;

  /** Every spec swarmy ever deployed + every live spec — none may hold `value`. */
  const assertNowhere = (value: string) => {
    expect(value.length).toBeGreaterThan(8);
    for (const spec of specsSeen) expect(JSON.stringify(spec)).not.toContain(value);
    for (const s of services.values()) expect(JSON.stringify(s)).not.toContain(value);
  };
  return { ctx, services, secrets, roles, specsSeen, execs, put, assertNowhere };
}

export const APP = 'shop_web';
export function addApp(
  w: ReturnType<typeof world>,
  env: Record<string, string> = { LOG: 'debug' },
  labels: Record<string, string> = {},
  image = 'web:1',
) {
  w.put({
    name: APP,
    image,
    labels: { 'com.docker.stack.namespace': STACK, ...labels },
    env,
    networks: ['shop_default'],
  });
}

