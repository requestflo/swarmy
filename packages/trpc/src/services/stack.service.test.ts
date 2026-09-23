import { describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  carryIngressRoutes,
  deployFromCompose,
  findLegacyServices,
  splitLegacyRemovals,
} from './stack.service';

/**
 * Compose deploys follow `docker stack deploy` semantics: `<stack>_<svc>`
 * names, `<stack>_<vol>` volumes, a `<stack>_default` overlay aliased by the
 * short service name — and a safe cut-over for stacks deployed under the old
 * bare-name scheme (named volumes are REUSED, legacy removed AFTER the new one).
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

function svc(partial: Partial<SwarmServiceInfo> & { name: string }): SwarmServiceInfo {
  return {
    id: `id-${partial.name}`,
    image: 'img:1',
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
    ...partial,
  } as SwarmServiceInfo;
}

function fakeCtx(live: SwarmServiceInfo[] = []) {
  const dispatched: { command: string; payload: Record<string, unknown> }[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: {
        findUnique: async () => ({ rulesJson: ALL_OFF, productionSafetyMode: false }),
      },
      exposureConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      stack: {
        upsert: async ({ create }: { create: { name: string } }) => ({
          id: 'stack-1',
          name: create.name,
        }),
      },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
    },
    hub: {
      liveInventory: () => ({ services: live, containers: [] }),
      isOnline: () => true,
      managerNode: () => 'node1',
      dispatch: async (_node: string, command: string, payload: Record<string, unknown>) => {
        dispatched.push({ command, payload });
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched };
}

const deployed = (d: { command: string; payload: Record<string, unknown> }[]) =>
  d.filter((x) => x.command === 'service.deploy').map((x) => x.payload.spec as ServiceSpec);

const APP = `
services:
  web:
    image: nginx:1.27-alpine
    ports: ["8080:80"]
    environment:
      DB_HOST: db
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

describe('deployFromCompose — docker stack semantics', () => {
  it('ensures <stack>_default BEFORE deploying prefixed, aliased services with a named volume', async () => {
    const { ctx, dispatched } = fakeCtx();
    const res = await deployFromCompose(ctx, { name: 'site', composeSource: APP });

    expect(res.services).toEqual(['site_web', 'site_db']);
    expect(res.migrated).toEqual([]);
    expect(dispatched.map((d) => d.command)).toEqual([
      'network.ensure',
      'service.deploy',
      'service.deploy',
    ]);
    expect(dispatched[0]!.payload).toMatchObject({
      name: 'site_default',
      driver: 'overlay',
      attachable: true,
    });

    const [web, db] = deployed(dispatched);
    expect(web).toMatchObject({
      name: 'site_web',
      networks: ['site_default'],
      networkAliases: { site_default: ['web'] },
      env: { DB_HOST: 'db' },
    });
    expect(web!.labels).toMatchObject({
      'com.docker.stack.namespace': 'site',
      'swarmy.managed': 'true',
    });
    expect(db!.mounts).toEqual([
      {
        type: 'volume',
        source: 'site_pgdata',
        target: '/var/lib/postgresql/data',
        readOnly: false,
      },
    ]);
    expect(db!.networkAliases).toEqual({ site_default: ['db'] });
  });

  it('two stacks with the same compose service name deploy DISTINCT services', async () => {
    const compose = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
    const a = fakeCtx();
    const b = fakeCtx();
    await deployFromCompose(a.ctx, { name: 'a', composeSource: compose });
    await deployFromCompose(b.ctx, { name: 'b', composeSource: compose });
    expect(deployed(a.dispatched).map((s) => s.name)).toEqual(['a_web']);
    expect(deployed(b.dispatched).map((s) => s.name)).toEqual(['b_web']);
  });

  it('a build-only service is a 400, never a half-deploy', async () => {
    const { ctx, dispatched } = fakeCtx();
    await expect(
      deployFromCompose(ctx, { name: 's', composeSource: 'services:\n  web:\n    build: .\n' }),
    ).rejects.toThrow(/no image/);
    expect(dispatched).toHaveLength(0);
  });
});

describe('deployFromCompose — legacy bare-name migration', () => {
  const legacyDb = svc({
    name: 'db',
    labels: { 'com.docker.stack.namespace': 'site' },
    mounts: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }],
  });
  const legacyWeb = svc({
    name: 'web',
    labels: {
      'com.docker.stack.namespace': 'site',
      'swarmy.ingress.routes': JSON.stringify([
        { host: 'site.example.com', port: 80, tls: 'auto' },
      ]),
      'swarmy.ingress': 'true',
    },
    networks: [{ name: 'swarmy', aliases: [] }],
    ports: [{ target: 80, published: 8080, protocol: 'tcp' }],
    mounts: [],
  });
  // Same bare name, other stack's namespace — never touched.
  const otherStack = svc({ name: 'cache', labels: { 'com.docker.stack.namespace': 'other' } });

  it('keeps the legacy NAMED volume, carries the route, and removes legacy only after (port clash first)', async () => {
    const { ctx, dispatched } = fakeCtx([legacyDb, legacyWeb, otherStack]);
    const res = await deployFromCompose(ctx, { name: 'site', composeSource: APP });

    expect(res.migrated.sort()).toEqual(['db', 'web']);
    const target = (p: Record<string, unknown>) =>
      String(p.service ?? (p.spec as ServiceSpec | undefined)?.name ?? p.name);
    expect(dispatched.map((d) => `${d.command}:${target(d.payload)}`)).toEqual([
      'network.ensure:site_default',
      // `web` publishes 8080 like the new site_web → must go first.
      'service.remove:web',
      'service.deploy:site_web',
      'service.deploy:site_db',
      // `db` (no port clash) goes only AFTER its replacement is deployed.
      'service.remove:db',
    ]);

    const [web, db] = deployed(dispatched);
    expect(db!.mounts?.[0]?.source).toBe('pgdata'); // NOT site_pgdata — data not orphaned
    expect(web!.labels?.['swarmy.ingress.routes']).toBe(legacyWeb.labels['swarmy.ingress.routes']);
    expect(web!.networks).toEqual(['site_default', 'swarmy']);
    expect(res.warnings.map((w) => w.code)).toContain('legacy-volume-reused');
  });

  it('findLegacyServices ignores other stacks and already-prefixed services', () => {
    const prefixed = svc({ name: 'site_web', labels: { 'com.docker.stack.namespace': 'site' } });
    const m = findLegacyServices([legacyDb, otherStack, prefixed], 'site', ['db', 'web', 'cache']);
    expect(m.legacy.map((s) => s.name)).toEqual(['db']);
    expect(m.legacyVolumes).toEqual({ db: { '/var/lib/postgresql/data': 'pgdata' } });
  });

  it('findLegacyServices also migrates double-prefixed blueprint services (wp_wp-db → wp_db)', () => {
    const doubled = svc({
      name: 'site_site-db',
      labels: { 'com.docker.stack.namespace': 'site' },
      mounts: [{ type: 'volume', source: 'site_site-db-data', target: '/var/lib/mysql' }],
    });
    const prefixed = svc({ name: 'site_web', labels: { 'com.docker.stack.namespace': 'site' } });
    const m = findLegacyServices([doubled, prefixed, otherStack], 'site', ['db', 'web']);
    expect(m.legacy.map((s) => s.name)).toEqual(['site_site-db']);
    expect(m.shortOf).toEqual({ 'site_site-db': 'db' });
    // Keyed by the SHORT so composeToStack keeps mounting the old volume.
    expect(m.legacyVolumes).toEqual({ db: { '/var/lib/mysql': 'site_site-db-data' } });
  });

  it('an old agent (no mounts reported) is flagged for an inspect, not assumed volume-less', () => {
    const m = findLegacyServices([{ ...legacyDb, mounts: undefined }], 'site', ['db']);
    expect(m.unknownMounts).toEqual(['db']);
  });

  it('splitLegacyRemovals only front-loads published-port clashes', () => {
    const specs = [
      {
        name: 'site_web',
        image: 'x',
        ports: [{ target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' }],
      },
    ] as ServiceSpec[];
    expect(splitLegacyRemovals([legacyWeb, legacyDb], specs)).toEqual({
      before: ['web'],
      after: ['db'],
    });
  });

  it('carryIngressRoutes never overrides routes the compose sets itself', () => {
    const spec = {
      name: 'site_web',
      image: 'x',
      labels: { 'swarmy.ingress.routes': '[]' },
    } as ServiceSpec;
    expect(carryIngressRoutes(spec, legacyWeb)).toBe(spec);
  });
});
