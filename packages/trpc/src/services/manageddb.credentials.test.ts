import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import {
  injectConnection,
  migrateDbCredentials,
  provisionDb,
  readDbPassword,
  revealDbPassword,
  rotateDbPassword,
  rotateRolesScript,
} from './manageddb.service';

/**
 * Security (owner decision): managed Postgres passwords are Docker SECRETS
 * (`<family>__v<n>`, mounted at `/run/secrets/<family>`), never spec env.
 * A small stateful fake swarm runs provision → inject → reveal → rotate and a
 * legacy migration, and after every step asserts that NO service spec (and no
 * one-shot payload) anywhere carries a plaintext DB password.
 */

type Ref = { source: string; target?: string };
interface Svc {
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

const STACK = 'shop';
const CLUSTER = 'main';

function world() {
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
  const put = (spec: Record<string, any>) => {
    const prev = services.get(spec.name);
    specsSeen.push(spec);
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

const APP = 'shop_web';
function addApp(w: ReturnType<typeof world>, env: Record<string, string> = { LOG: 'debug' }, labels: Record<string, string> = {}) {
  w.put({
    name: APP,
    image: 'web:1',
    labels: { 'com.docker.stack.namespace': STACK, ...labels },
    env,
    networks: ['shop_default'],
  });
}

describe('managed Postgres credentials are Docker secrets', () => {
  it('provision: the password is a secret file on every member; no spec carries it', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'provisioned-secret-pw', autoBackup: false });
    expect(w.secrets.get('shop_main-pg-password__v1')).toBe('provisioned-secret-pw');
    for (const name of ['shop_main-primary', 'shop_main-replica']) {
      const s = w.services.get(name)!;
      expect(s.env).toContain('POSTGRES_PASSWORD_FILE=/run/secrets/shop_main-pg-password');
      expect(s.env).toContain('SWARMY_PG_REPLICATION_PASSWORD_FILE=/run/secrets/shop_main-pg-password');
      expect(s.env.some((e) => e.startsWith('POSTGRES_PASSWORD='))).toBe(false);
      expect(s.refs).toContainEqual({ source: 'shop_main-pg-password__v1', target: 'shop_main-pg-password' });
    }
    w.assertNowhere('provisioned-secret-pw');
  });

  it('reveal reads the mounted secret through exec (the secret-read path), audited', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'reveal-me-password', autoBackup: false });
    expect(await revealDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER })).toEqual({ cluster: CLUSTER, password: 'reveal-me-password' });
    expect(w.execs).toContainEqual(['cat', '/run/secrets/shop_main-pg-password']);
  });

  it('inject: DATABASE_URL is a secret delivered as env; the app spec holds no password', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'inject-secret-pw', autoBackup: false });
    addApp(w);
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const app = w.services.get(APP)!;
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-url__v1', target: 'DATABASE_URL' });
    expect(app.secretEnv).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    expect(w.secrets.get('shop_main-pg-url__v1')).toBe('postgres://postgres:inject-secret-pw@shop_main-primary:5432/app');
    w.assertNowhere('inject-secret-pw');
  });

  it('rotate: new secret version, roles re-set from the new file, members + apps moved, old versions removed', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'old-rotating-password', autoBackup: false });
    addApp(w);
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const res = await rotateDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER }, { pollMs: 1, waitMs: 1000 });
    expect(res.version).toBe(2);
    const next = w.secrets.get('shop_main-pg-password__v2')!;
    expect(next).toBeDefined();
    expect(next).not.toBe('old-rotating-password');
    expect(w.roles).toEqual({ postgres: next, repl: next });
    for (const name of ['shop_main-primary', 'shop_main-replica']) {
      expect(w.services.get(name)!.refs).toContainEqual({ source: 'shop_main-pg-password__v2', target: 'shop_main-pg-password' });
    }
    expect(w.services.get(APP)!.refs).toContainEqual({ source: 'shop_main-pg-url__v2', target: 'DATABASE_URL' });
    expect(w.secrets.has('shop_main-pg-password__v1')).toBe(false);
    expect(w.secrets.has('shop_main-pg-url__v1')).toBe(false);
    // The ALTER never carries the value in argv.
    for (const cmd of w.execs) expect(cmd.join(' ')).not.toContain(next);
    w.assertNowhere('old-rotating-password');
    w.assertNowhere(next);
  });

  it('rotateRolesScript reads the new password from the file, never argv', () => {
    const s = rotateRolesScript('/run/secrets/shop_main-pg-password', 'repl');
    expect(s).toContain('\\set p `cat /run/secrets/shop_main-pg-password`');
    expect(s).toContain("ALTER ROLE %I PASSWORD %L', 'postgres', :'p'");
  });

  it('migration: a legacy plain-env cluster moves onto a secret in ONE update per member, apps too', async () => {
    const w = world();
    const legacyEnv = (role: string) => ({
      SWARMY_PG_ROLE: role,
      POSTGRES_PASSWORD: 'legacy-plain-password',
      POSTGRES_DB: 'app',
      SWARMY_PG_REPLICATION_USER: 'repl',
      SWARMY_PG_REPLICATION_PASSWORD: 'legacy-plain-password',
      ...(role === 'replica' ? { SWARMY_PG_PRIMARY_HOST: 'shop_main-primary' } : {}),
    });
    const member = (name: string, role: string, volume: string) => ({
      name,
      image: 'pgvector/pgvector:pg17',
      labels: {
        'com.docker.stack.namespace': STACK,
        'swarmy.db.cluster': CLUSTER,
        'swarmy.db.role': role,
        'swarmy.db.dataVolume': volume,
      },
      env: legacyEnv(role),
      networks: ['shop_main-net'],
      mounts: [{ type: 'volume', source: volume, target: '/var/lib/postgresql/data' }],
      command: ['/bin/sh', '-c', 'old boot script'],
    });
    w.put(member('shop_main-primary', 'primary', 'shop_main-primary-data'));
    w.put(member('shop_main-replica', 'replica', 'shop_main-replica-data'));
    addApp(
      w,
      { LOG: 'debug', DATABASE_URL: 'postgres://postgres:legacy-plain-password@shop_main-primary:5432/app' },
      { 'swarmy.db.inject': CLUSTER, 'swarmy.db.inject.var': 'DATABASE_URL' },
    );
    const deploysBefore = w.specsSeen.length;
    w.specsSeen.length = 0; // the legacy seed specs held the value by construction

    const res = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(res.members).toEqual(['shop_main-primary', 'shop_main-replica']);
    expect(res.consumers).toEqual([APP]);
    expect(deploysBefore).toBe(3);
    // One deploy per member, one for the app.
    expect(w.specsSeen.map((s: any) => s.name)).toEqual(['shop_main-primary', 'shop_main-replica', APP]);
    expect(w.secrets.get('shop_main-pg-password__v1')).toBe('legacy-plain-password');
    const primary = w.services.get('shop_main-primary')!;
    expect(primary.labels['swarmy.db.passwordSecret']).toBe('shop_main-pg-password__v1');
    expect(primary.command?.[2]).toContain('SWARMY_PG_REPLICATION_PASSWORD_FILE'); // boot layer re-stamped
    expect(primary.mounts[0]?.source).toBe('shop_main-primary-data'); // data volume kept
    w.assertNowhere('legacy-plain-password');

    // Idempotent: a second tick changes nothing.
    const again = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(again.members).toEqual([]);
    expect(again.consumers).toEqual([]);
    expect(await readDbPassword(w.ctx, STACK, CLUSTER)).toBe('legacy-plain-password');
  });

  it('migration never restarts a writer whose data is not on a persistent volume', async () => {
    const w = world();
    w.put({
      name: 'shop_main-primary',
      image: 'pg',
      labels: { 'com.docker.stack.namespace': STACK, 'swarmy.db.cluster': CLUSTER, 'swarmy.db.role': 'primary' },
      env: { POSTGRES_PASSWORD: 'anon-volume-password' },
      mounts: [],
    });
    const before = w.specsSeen.length;
    expect((await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER })).members).toEqual([]);
    expect(w.specsSeen.length).toBe(before);
  });
});
