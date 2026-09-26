import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../../context';
import { deployBlueprint } from '../blueprints.service';
import { withCreateTimeWires } from './create-wires';

/**
 * QA-073: a template's database read its generated password on FIRST boot,
 * but the blueprint deploy created the service first and attached the secret
 * afterwards. MySQL initialised without MYSQL_PASSWORD, never created the app
 * user, and every later task was ER_ACCESS_DENIED. The first service.deploy
 * of every service must already carry its generated secrets / credential env.
 */

const ALL_OFF = [
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
].map((id) => ({ id, enabled: false, severity: 'block' }));

function fakeCtx() {
  const dispatched: { command: string; payload: Record<string, any> }[] = [];
  const live = new Map<string, ServiceSpec>();
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: { findUnique: async () => ({ rulesJson: ALL_OFF, productionSafetyMode: false }) },
      exposureConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
      emailConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
    },
    hub: {
      liveInventory: () => ({
        services: [...live.values()].map((s) => ({
          id: `id-${s.name}`,
          name: s.name,
          image: s.image,
          mode: 'replicated',
          desiredReplicas: 1,
          runningReplicas: 1,
          createdAt: 0,
          updatedAt: 0,
          labels: s.labels ?? {},
          networks: [],
          env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`),
          ports: [],
          secrets: (s.secrets ?? []).map((r) => r.source),
          configs: [],
        })),
        containers: [],
      }),
      isOnline: () => true,
      onlineNodeIds: () => ['node1'],
      managerNode: () => 'node1',
      nodeInventory: () => [],
      dispatch: async (_node: string, command: string, payload: Record<string, any>) => {
        dispatched.push({ command, payload });
        if (command === 'service.deploy') live.set(payload.spec.name, payload.spec);
        if (command === 'secret.list') return { secrets: [] };
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched };
}

/** The spec each service was FIRST created with. */
function firstCreates(d: { command: string; payload: Record<string, any> }[]): Map<string, ServiceSpec> {
  const out = new Map<string, ServiceSpec>();
  for (const x of d) {
    if (x.command === 'service.deploy' && !out.has(x.payload.spec.name)) out.set(x.payload.spec.name, x.payload.spec);
  }
  return out;
}

describe('blueprint deploy wires generated secrets at CREATE (QA-073)', () => {
  it('ghost: MySQL is created with its password secret mounted + MYSQL_PASSWORD_FILE; ghost with its env-delivered password', async () => {
    const { ctx, dispatched } = fakeCtx();
    const res = await deployBlueprint(ctx, { id: 'ghost', params: { name: 'blog', size: 'm', options: {} } });
    const created = firstCreates(dispatched);
    const secretCreate = dispatched.findIndex((d) => d.command === 'secret.create');
    const firstDeploy = dispatched.findIndex((d) => d.command === 'service.deploy');
    expect(secretCreate).toBeGreaterThanOrEqual(0);
    expect(secretCreate).toBeLessThan(firstDeploy);
    const physical = dispatched[secretCreate]!.payload.name as string;

    const mysql = created.get('blog_mysql')!;
    expect(mysql.secrets).toContainEqual({ source: physical, target: 'blog-db-password' });
    expect(mysql.env?.MYSQL_PASSWORD_FILE).toBe('/run/secrets/blog-db-password');
    expect(mysql.env?.MYSQL_USER).toBe('ghost');

    const ghost = created.get('blog_ghost')!;
    expect(ghost.secrets).toContainEqual({ source: physical, target: 'database__connection__password' });
    expect(ghost.secretEnv).toContain('database__connection__password');
    // The value itself never lands in the spec env.
    expect(Object.values(ghost.env ?? {})).not.toContain(expect.stringMatching(/__SWARMY_/));
    expect(res.steps.find((s) => s.kind === 'stack.deploy')?.status).toBe('succeeded');
  });

  for (const id of ['wordpress', 'matomo', 'bookstack', 'mautic']) {
    it(`${id}: every service's first create already carries its generated secrets`, async () => {
      const { ctx, dispatched } = fakeCtx();
      await deployBlueprint(ctx, { id, params: { name: 'app', size: 'm', options: {} } });
      const created = firstCreates(dispatched);
      const families = dispatched.filter((d) => d.command === 'secret.create').map((d) => d.payload.name as string);
      expect(families.length).toBeGreaterThan(0);
      const mounted = [...created.values()].flatMap((s) => (s.secrets ?? []).map((r) => r.source));
      for (const f of families) expect(mounted).toContain(f);
      // Every *_PASSWORD_FILE on a created spec points at a secret it mounts.
      for (const s of created.values()) {
        for (const [k, v] of Object.entries(s.env ?? {})) {
          if (!k.endsWith('_FILE') || !v.startsWith('/run/secrets/')) continue;
          expect((s.secrets ?? []).map((r) => `/run/secrets/${r.target ?? r.source}`)).toContain(v);
        }
      }
    });
  }
});

describe('withCreateTimeWires', () => {
  const spec: ServiceSpec = { name: 's_db', image: 'mysql:8.4.7', env: { A: '1' } } as ServiceSpec;
  it('mounts file secrets at the family path, env secrets at their env name, and substitutes tokens', () => {
    const out = withCreateTimeWires(
      spec,
      [
        { type: 'secret', service: 'db', family: 's-pw', envName: 'PW_FILE' },
        { type: 'secret', service: 'db', family: 's-pw', envName: 'PW', delivery: 'env' },
        { type: 'env', service: 'db', env: { URL: 'x://u:__SWARMY_T__@h' } },
      ],
      { 's-pw': 's-pw__v1' },
      { __SWARMY_T__: 'sekret' },
    );
    expect(out.secrets).toEqual([
      { source: 's-pw__v1', target: 's-pw' },
      { source: 's-pw__v1', target: 'PW' },
    ]);
    expect(out.env).toEqual({ A: '1', PW_FILE: '/run/secrets/s-pw', URL: 'x://u:sekret@h' });
    expect(out.secretEnv).toEqual(['PW']);
  });
  it('refuses a secret this plan did not create', () => {
    expect(() => withCreateTimeWires(spec, [{ type: 'secret', service: 'db', family: 'nope', envName: 'X' }], {}, {})).toThrow(/not created/);
  });
});
