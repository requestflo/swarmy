import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  CONFIG_FAMILY_LABEL,
  CONFIG_MOUNT_LABEL,
  CONFIG_ORG_LABEL,
  CONFIG_VERSION_LABEL,
  SECRET_FAMILY_LABEL,
  SECRET_ORG_LABEL,
  SECRET_VERSION_LABEL,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { attachAiToService } from './ai.service';
import { detach as detachBucket } from './buckets.service';
import {
  attachCacheToService,
  CACHE_CLUSTER_LABEL,
  CACHE_ENGINE_LABEL,
  CACHE_INJECT_LABEL,
  CACHE_INJECT_VAR_LABEL,
  CACHE_ROLE_LABEL,
  detachCacheFromService,
} from './cache.service';
import { attachConfigToService, detachConfigFromService } from './configsMgr.service';
import { DB_CLUSTER_LABEL, DB_ROLE_LABEL, injectConnection } from './manageddb.service';
import { promoteSpecFrom } from './releases.service';
import {
  attachSearchToService,
  detachSearchFromService,
  SEARCH_CLUSTER_LABEL,
  SEARCH_ENGINE_LABEL,
  SEARCH_INJECT_LABEL,
} from './search.service';
import { attachSecretToService, detachSecretFromService, rotateSecretFamily } from './secretsMgr.service';
import { updateService } from './service.service';
import { applyServicePatch, patchLiveService, specFromInspect } from './service-patch';
import { seedKv } from './swarm-kv.service';
import {
  attachVectorToService,
  detachVectorFromService,
  VECTOR_INJECT_LABEL,
  VECTOR_KIND_LABEL,
  VECTOR_NAME_LABEL,
} from './vector.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

/**
 * GOLDEN (data-loss gate): every mutation that changes ONE aspect of a live
 * app service (env / secrets / configs / labels / networks / image) must carry
 * everything else the service already has. The agent's `service.deploy` is a
 * full-spec replace, and the inventory view has no mounts/command/placement —
 * a spec rebuilt from it silently detached the app's named data volume.
 *
 * The live app below has a named volume, command+args, a placement constraint
 * (+ spread preference, max-per-node), resources, a healthcheck, a restart
 * policy, a published port, a secret AND a config mounted at custom targets.
 */

const STACK = 'shop';
const APP = 'shop_api';
const STACK_NS = 'com.docker.stack.namespace';

function liveInspect(overrides: { labels?: Record<string, string>; env?: string[]; secrets?: unknown[]; configs?: unknown[] } = {}) {
  return {
    ID: 'svc-api',
    Version: { Index: 7 },
    Spec: {
      Name: APP,
      Labels: { [STACK_NS]: STACK, 'swarmy.env': 'production', ...(overrides.labels ?? {}) },
      Mode: { Replicated: { Replicas: 2 } },
      TaskTemplate: {
        ContainerSpec: {
          Image: 'ghcr.io/acme/api:1.2.3@sha256:abc',
          Command: ['/app/server'],
          Args: ['--port', '8080'],
          Env: overrides.env ?? ['LOG=debug'],
          Mounts: [{ Type: 'volume', Source: 'shop_data', Target: '/data' }],
          Secrets: overrides.secrets ?? [
            { SecretName: 'tls__v1', File: { Name: 'tls', UID: '0', GID: '0', Mode: 0o400 } },
          ],
          Configs: overrides.configs ?? [
            { ConfigName: 'proxy-conf', File: { Name: '/etc/proxy.conf', UID: '0', GID: '0', Mode: 0o444 } },
          ],
          Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost:8080/health'], Interval: 10e9, Retries: 3 },
          StopGracePeriod: 30e9,
        },
        Placement: {
          Constraints: ['node.labels.tier==data'],
          Preferences: [{ Spread: { SpreadDescriptor: 'node.labels.zone' } }],
          MaxReplicas: 1,
        },
        Resources: { Limits: { NanoCPUs: 5e8, MemoryBytes: 268435456 } },
        RestartPolicy: { Condition: 'on-failure', MaxAttempts: 3 },
        Networks: [{ Target: 'net-shop-default', Aliases: ['api'] }],
      },
      EndpointSpec: { Ports: [{ TargetPort: 8080, PublishedPort: 8080, Protocol: 'tcp', PublishMode: 'ingress' }] },
    },
  };
}

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

/** The app as the (lossy) inventory sees it — no mounts/command/placement. */
function appInfo(extra: { labels?: Record<string, string>; env?: string[]; secrets?: string[]; configs?: string[] } = {}) {
  return svc({
    id: 'svc-api',
    name: APP,
    image: 'ghcr.io/acme/api:1.2.3',
    desiredReplicas: 2,
    runningReplicas: 2,
    labels: { [STACK_NS]: STACK, 'swarmy.env': 'production', ...(extra.labels ?? {}) },
    networks: [{ name: 'shop_default', aliases: ['api'] }],
    env: extra.env ?? ['LOG=debug'],
    ports: [{ target: 8080, published: 8080, protocol: 'tcp' }],
    secrets: extra.secrets ?? ['tls__v1'],
    configs: extra.configs ?? ['proxy-conf'],
  });
}

interface Dispatch {
  node: string;
  command: string;
  payload: Record<string, unknown>;
}

function fakeCtx(opts: {
  services: SwarmServiceInfo[];
  inspect?: unknown;
  db?: Record<string, unknown>;
  /** The org's Garage store config (swarm-kv `storage/<orgId>`). */
  store?: Record<string, unknown>;
  respond?: (command: string, payload: Record<string, unknown>) => unknown;
}) {
  const dispatched: Dispatch[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'user1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: { findUnique: async () => null },
      exposureConfig: { findUnique: async () => null },
      registryConfig: { findUnique: async () => null },
      backupSchedule: { count: async () => 0 },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
      ...(opts.db ?? {}),
    },
    hub: {
      liveInventory: () => ({ services: opts.services, containers: [] }),
      isOnline: () => true,
      managerNode: () => 'node1',
      swarmNodeIdFor: () => undefined,
      dispatch: async (node: string, command: string, payload: Record<string, unknown>) => {
        dispatched.push({ node, command, payload });
        if (command === 'service.inspect') return { inspect: opts.inspect ?? liveInspect() };
        return opts.respond?.(command, payload) ?? {};
      },
    },
  } as unknown as OrgContext;
  if (opts.store) seedKv(ctx.hub, 'org1', 'storage', 'org1', opts.store);
  const deployed = (): ServiceSpec => {
    const d = dispatched.filter((x) => x.command === 'service.deploy');
    expect(d).toHaveLength(1);
    return d[0]!.payload.spec as ServiceSpec;
  };
  return { ctx, dispatched, deployed };
}

/** Everything a one-aspect patch must NEVER drop. */
function expectCarried(spec: ServiceSpec) {
  expect(spec.name).toBe(APP);
  expect(spec.mounts).toEqual([{ type: 'volume', source: 'shop_data', target: '/data' }]);
  expect(spec.command).toEqual(['/app/server']);
  expect(spec.args).toEqual(['--port', '8080']);
  expect(spec.placement).toEqual({
    constraints: ['node.labels.tier==data'],
    preferences: ['spread=node.labels.zone'],
    maxReplicasPerNode: 1,
  });
  expect(spec.resources).toEqual({ limits: { cpus: 0.5, memoryBytes: 268435456 } });
  expect(spec.healthcheck).toEqual({
    test: ['CMD', 'curl', '-f', 'http://localhost:8080/health'],
    intervalNs: 10e9,
    retries: 3,
  });
  expect(spec.restartPolicy).toEqual({ condition: 'on-failure', maxAttempts: 3 });
  expect(spec.stopGracePeriodNs).toBe(30e9);
  expect(spec.mode).toEqual({ replicated: { replicas: 2 } });
  expect(spec.ports).toEqual([{ target: 8080, published: 8080, protocol: 'tcp', mode: 'ingress' }]);
  expect(spec.networks).toContain('shop_default');
  expect(spec.labels?.['swarmy.env']).toBe('production');
  expect(spec.labels?.[STACK_NS]).toBe(STACK);
  // Aliases ride the agent's carryNetworkAliases — a patch never overrides them.
  expect(spec.networkAliases).toBeUndefined();
}
const expectTlsSecretKept = (spec: ServiceSpec) =>
  expect(spec.secrets).toContainEqual({ source: 'tls__v1', target: 'tls', uid: '0', gid: '0', mode: 0o400 });
const expectProxyConfigKept = (spec: ServiceSpec) =>
  expect(spec.configs).toContainEqual({
    source: 'proxy-conf',
    target: '/etc/proxy.conf',
    uid: '0',
    gid: '0',
    mode: 0o444,
  });

// ── pure codec + patch ───────────────────────────────────────────────────────

describe('specFromInspect', () => {
  it('decodes the full live spec (volume, command, placement, resources, refs with targets)', () => {
    const spec = specFromInspect(liveInspect(), ['shop_default'])!;
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.env).toEqual({ LOG: 'debug' });
  });

  it('decodes a disabled healthcheck and global mode', () => {
    const raw = liveInspect();
    raw.Spec.TaskTemplate.ContainerSpec.Healthcheck = { Test: ['NONE'] } as never;
    (raw.Spec as { Mode: unknown }).Mode = { Global: {} };
    const spec = specFromInspect(raw, [])!;
    expect(spec.healthcheck).toEqual({ disable: true });
    expect(spec.mode).toEqual({ global: {} });
  });

  it('is null for an unusable payload', () => {
    expect(specFromInspect({}, [])).toBeNull();
    expect(specFromInspect(null, [])).toBeNull();
  });

  it('promoteSpecFrom still swaps the image over the same codec', () => {
    const spec = promoteSpecFrom(liveInspect(), 'ghcr.io/acme/api:2.0.0', ['shop_default'])!;
    expect(spec.image).toBe('ghcr.io/acme/api:2.0.0');
    expectCarried(spec);
  });
});

describe('applyServicePatch', () => {
  const base = specFromInspect(liveInspect(), ['shop_default'])!;

  it('merges env/labels/secrets/networks and carries everything else', () => {
    const out = applyServicePatch(base, {
      setEnv: { REDIS_URL: 'redis://c:6379' },
      setLabels: { 'swarmy.cache.inject': 'c' },
      addSecrets: [{ source: 'redis-pw' }],
      addNetworks: ['shop_c-net', 'shop_default'],
    });
    expectCarried(out);
    expectTlsSecretKept(out);
    expect(out.env).toEqual({ LOG: 'debug', REDIS_URL: 'redis://c:6379' });
    expect(out.secrets).toContainEqual({ source: 'redis-pw' });
    expect(out.networks).toEqual(['shop_default', 'shop_c-net']);
    expect(out.labels?.['swarmy.cache.inject']).toBe('c');
  });

  it('removes exactly what it names (list or predicate), removal before add', () => {
    const out = applyServicePatch(
      { ...base, env: { LOG: 'debug', A: '1', B: '2' } },
      {
        removeEnv: (k) => k === 'A',
        removeLabels: ['swarmy.env'],
        removeSecrets: ['tls__v1'],
        addSecrets: [{ source: 'tls__v2', target: 'tls' }],
        removeNetworks: ['shop_default'],
        removeConfigs: ['proxy-conf'],
      },
    );
    expect(out.env).toEqual({ LOG: 'debug', B: '2' });
    expect(out.labels?.['swarmy.env']).toBeUndefined();
    expect(out.secrets).toEqual([{ source: 'tls__v2', target: 'tls' }]);
    expect(out.configs).toBeUndefined();
    expect(out.networks).toBeUndefined();
    expect(out.mounts).toEqual(base.mounts);
  });

  it('re-adding a secret by source replaces (never duplicates) its ref', () => {
    const out = applyServicePatch(base, { addSecrets: [{ source: 'tls__v1' }] });
    expect(out.secrets).toEqual([{ source: 'tls__v1' }]);
  });
});

describe('patchLiveService', () => {
  it('refuses (dispatching no deploy) when the live spec cannot be read', async () => {
    const { ctx, dispatched } = fakeCtx({ services: [appInfo()], inspect: {} });
    await expect(
      patchLiveService(ctx, { name: APP, networks: [] }, { setEnv: { A: '1' } }),
    ).rejects.toThrow(/refusing a redeploy/);
    expect(dispatched.some((d) => d.command === 'service.deploy')).toBe(false);
  });

  it('prefers the inventory image (tag) over the digest-pinned inspect image', async () => {
    const { ctx, deployed } = fakeCtx({ services: [appInfo()] });
    await patchLiveService(ctx, { name: APP, image: 'ghcr.io/acme/api:1.2.3', networks: ['shop_default'] }, {});
    expect(deployed().image).toBe('ghcr.io/acme/api:1.2.3');
    expectCarried(deployed());
  });
});

// ── per-offender goldens ─────────────────────────────────────────────────────

describe('manageddb.injectConnection keeps the app whole', () => {
  it('adds DATABASE_URL + network + inject labels, carries volume/command/placement', async () => {
    const primary = svc({
      name: 'shop_pg-primary',
      labels: { [STACK_NS]: STACK, [DB_CLUSTER_LABEL]: 'pg', [DB_ROLE_LABEL]: 'primary' },
      env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'],
    });
    const { ctx, deployed } = fakeCtx({ services: [primary, appInfo()] });
    await injectConnection(ctx, { stack: STACK, appService: APP, cluster: 'pg' });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    // The URL embeds the password, so it is a Docker secret delivered as env
    // (secret-env shim) — the spec names the secret, never the value.
    expect(spec.env?.DATABASE_URL).toBeUndefined();
    expect(spec.secrets).toContainEqual({ source: 'shop_pg-pg-url__v1', target: 'DATABASE_URL' });
    expect(spec.secrets).toContainEqual({ source: 'shop_pg-pg-ro-url__v1', target: 'DATABASE_RO_URL' });
    expect(spec.secretEnv).toEqual(expect.arrayContaining(['DATABASE_URL', 'DATABASE_RO_URL']));
    expect(JSON.stringify(spec)).not.toContain('postgres://postgres:pw@');
    expect(spec.env?.LOG).toBe('debug');
    expect(spec.networks).toContain('shop_pg-net');
    expect(spec.labels?.['swarmy.db.inject']).toBe('pg');
  });
});

describe('cache attach/detach keep the app whole', () => {
  const cache = svc({
    name: 'shop_redis-primary',
    labels: { [STACK_NS]: STACK, [CACHE_CLUSTER_LABEL]: 'redis', [CACHE_ENGINE_LABEL]: 'redis', [CACHE_ROLE_LABEL]: 'primary' },
  });

  it('attach', async () => {
    const { ctx, deployed } = fakeCtx({ services: [cache, appInfo()] });
    const res = await attachCacheToService(ctx, { stack: STACK, cluster: 'redis', appService: APP, envVar: 'REDIS_URL' });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.env?.REDIS_URL).toBe(res.url);
    expect(spec.secrets?.some((s) => s.source.includes('redis'))).toBe(true);
    expect(spec.labels?.[CACHE_INJECT_LABEL]).toBe('redis');
  });

  it('detach removes only the cache wiring', async () => {
    const labels = { [CACHE_INJECT_LABEL]: 'redis', [CACHE_INJECT_VAR_LABEL]: 'REDIS_URL' };
    const { ctx, deployed } = fakeCtx({
      services: [cache, appInfo({ labels, env: ['LOG=debug', 'REDIS_URL=redis://x', 'REDIS_PASSWORD_FILE=/p'] })],
      inspect: liveInspect({ labels, env: ['LOG=debug', 'REDIS_URL=redis://x', 'REDIS_PASSWORD_FILE=/p'] }),
    });
    await detachCacheFromService(ctx, { stack: STACK, cluster: 'redis', appService: APP });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expect(spec.env).toEqual({ LOG: 'debug' });
    expect(spec.labels?.[CACHE_INJECT_LABEL]).toBeUndefined();
  });
});

describe('search attach/detach keep the app whole', () => {
  const search = svc({
    name: 'shop_meili',
    labels: { [STACK_NS]: STACK, [SEARCH_CLUSTER_LABEL]: 'meili', [SEARCH_ENGINE_LABEL]: 'meilisearch' },
  });

  it('attach', async () => {
    const { ctx, deployed } = fakeCtx({ services: [search, appInfo()] });
    await attachSearchToService(ctx, { stack: STACK, name: 'meili', appService: APP });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.labels?.[SEARCH_INJECT_LABEL]).toBe('meili');
    expect(spec.env?.LOG).toBe('debug');
  });

  it('detach', async () => {
    const labels = { [SEARCH_INJECT_LABEL]: 'meili' };
    const { ctx, deployed } = fakeCtx({ services: [search, appInfo({ labels })], inspect: liveInspect({ labels }) });
    await detachSearchFromService(ctx, { stack: STACK, name: 'meili', appService: APP });
    const spec = deployed();
    expectCarried(spec);
    expect(spec.labels?.[SEARCH_INJECT_LABEL]).toBeUndefined();
  });
});

describe('vector attach/detach keep the app whole', () => {
  const qdrant = svc({
    name: 'shop_vec',
    labels: { [STACK_NS]: STACK, [VECTOR_KIND_LABEL]: 'qdrant', [VECTOR_NAME_LABEL]: 'vec' },
  });

  it('attach', async () => {
    const { ctx, deployed } = fakeCtx({ services: [qdrant, appInfo()] });
    await attachVectorToService(ctx, { stack: STACK, name: 'vec', appService: APP, envVar: 'QDRANT_URL' });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expect(spec.env?.QDRANT_URL).toBe('http://shop_vec:6333');
  });

  it('detach', async () => {
    const labels = { [VECTOR_INJECT_LABEL]: 'vec' };
    const { ctx, deployed } = fakeCtx({ services: [qdrant, appInfo({ labels })], inspect: liveInspect({ labels }) });
    await detachVectorFromService(ctx, { stack: STACK, name: 'vec', appService: APP });
    const spec = deployed();
    expectCarried(spec);
    expect(spec.labels?.[VECTOR_INJECT_LABEL]).toBeUndefined();
  });
});

describe('buckets.detach keeps the app whole', () => {
  it('drops only the S3 wiring', async () => {
    const labels = { 'swarmy.s3.bucket': 'assets', 'swarmy.s3.key': 'GK1', 'swarmy.s3.secret': 's3-sec' };
    const env = ['LOG=debug', 'S3_BUCKET=assets', 'S3_ACCESS_KEY_ID=GK1'];
    const { ctx, deployed } = fakeCtx({
      services: [appInfo({ labels, env, secrets: ['tls__v1', 's3-sec'] })],
      inspect: liveInspect({
        labels,
        env,
        secrets: [
          { SecretName: 'tls__v1', File: { Name: 'tls', UID: '0', GID: '0', Mode: 0o400 } },
          { SecretName: 's3-sec', File: { Name: 's3-sec', UID: '0', GID: '0', Mode: 0o444 } },
        ],
      }),
      store: {
        enabled: true,
        driver: 'GARAGE',
        region: 'swarmy',
        adminTokenRef: encryptSecret('tok'),
        memberNodeIds: [],
      },
    });
    await detachBucket(ctx, APP);
    const spec = deployed();
    expectCarried(spec);
    expect(spec.env).toEqual({ LOG: 'debug' });
    expect(spec.secrets).toEqual([{ source: 'tls__v1', target: 'tls', uid: '0', gid: '0', mode: 0o400 }]);
    expect(spec.labels?.['swarmy.s3.bucket']).toBeUndefined();
  });
});

describe('ai.attach keeps the app whole', () => {
  it('adds the gateway env + key secret only', async () => {
    const { ctx, deployed } = fakeCtx({
      services: [appInfo()],
      db: {
        aiProviderConfig: {
          findUnique: async () => ({
            providersJson: { providers: [{ kind: 'openai', isDefault: true }] },
            configEnc: encryptSecret(JSON.stringify({ openai: 'sk-test' })),
          }),
        },
        aiVirtualKey: {
          findFirst: async () => null,
          create: async () => ({ id: 'k1' }),
          update: async () => ({}),
        },
      },
    });
    await attachAiToService(ctx, { stack: STACK, appService: APP });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.env?.AI_GATEWAY_URL).toBeDefined();
    expect(spec.env?.LOG).toBe('debug');
  });
});

describe('secrets manager keeps consumers whole', () => {
  const secretList = (names: string[]) => ({
    secrets: names.map((name, i) => ({
      id: `s${i}`,
      name,
      createdAt: i,
      labels: { [SECRET_FAMILY_LABEL]: 'db-pass', [SECRET_VERSION_LABEL]: String(i + 1), [SECRET_ORG_LABEL]: 'org1' },
    })),
  });

  it('attach mounts the family at its stable target and carries the rest', async () => {
    const { ctx, deployed } = fakeCtx({
      services: [appInfo()],
      respond: (cmd) => (cmd === 'secret.list' ? secretList(['db-pass__v1']) : {}),
    });
    await attachSecretToService(ctx, { family: 'db-pass', service: APP, envName: 'DB_PASS_FILE' });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.secrets).toContainEqual({ source: 'db-pass__v1', target: 'db-pass' });
    expect(spec.env?.DB_PASS_FILE).toBe('/run/secrets/db-pass');
  });

  it('rotate swaps the version and repoints legacy env paths', async () => {
    const secrets = [
      { SecretName: 'tls__v1', File: { Name: 'tls', UID: '0', GID: '0', Mode: 0o400 } },
      { SecretName: 'db-pass__v1', File: { Name: 'db-pass', UID: '0', GID: '0', Mode: 0o444 } },
    ];
    const env = ['LOG=debug', 'OLD=/run/secrets/db-pass__v1'];
    const { ctx, deployed } = fakeCtx({
      services: [appInfo({ env, secrets: ['tls__v1', 'db-pass__v1'] })],
      inspect: liveInspect({ env, secrets }),
      respond: (cmd) => (cmd === 'secret.list' ? secretList(['db-pass__v1']) : {}),
    });
    await rotateSecretFamily(ctx, { family: 'db-pass', value: 'new' });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expect(spec.secrets?.map((s) => s.source).sort()).toEqual(['db-pass__v2', 'tls__v1']);
    expect(spec.env?.OLD).toBe('/run/secrets/db-pass');
  });

  it('detach drops the family refs + env pointing at it', async () => {
    const secrets = [
      { SecretName: 'tls__v1', File: { Name: 'tls', UID: '0', GID: '0', Mode: 0o400 } },
      { SecretName: 'db-pass__v1', File: { Name: 'db-pass', UID: '0', GID: '0', Mode: 0o444 } },
    ];
    const env = ['LOG=debug', 'DB_PASS_FILE=/run/secrets/db-pass'];
    const { ctx, deployed } = fakeCtx({
      services: [appInfo({ env, secrets: ['tls__v1', 'db-pass__v1'] })],
      inspect: liveInspect({ env, secrets }),
      respond: (cmd) => (cmd === 'secret.list' ? secretList(['db-pass__v1']) : {}),
    });
    await detachSecretFromService(ctx, { family: 'db-pass', service: APP });
    const spec = deployed();
    expectCarried(spec);
    expect(spec.secrets).toEqual([{ source: 'tls__v1', target: 'tls', uid: '0', gid: '0', mode: 0o400 }]);
    expect(spec.env).toEqual({ LOG: 'debug' });
  });
});

describe('configs manager keeps consumers whole', () => {
  const configList = {
    configs: [
      {
        id: 'c1',
        name: 'app-yaml__v1',
        createdAt: 1,
        labels: {
          [CONFIG_FAMILY_LABEL]: 'app-yaml',
          [CONFIG_VERSION_LABEL]: '1',
          [CONFIG_ORG_LABEL]: 'org1',
          [CONFIG_MOUNT_LABEL]: '/etc/app.yaml',
        },
      },
    ],
  };

  it('attach mounts the family at its path; unrelated configs keep their live target', async () => {
    const { ctx, deployed } = fakeCtx({
      services: [appInfo()],
      respond: (cmd) => (cmd === 'config.list' ? configList : {}),
    });
    await attachConfigToService(ctx, { family: 'app-yaml', service: APP });
    const spec = deployed();
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.configs).toContainEqual({ source: 'app-yaml__v1', target: '/etc/app.yaml' });
  });

  it('detach', async () => {
    const configs = [
      { ConfigName: 'proxy-conf', File: { Name: '/etc/proxy.conf', UID: '0', GID: '0', Mode: 0o444 } },
      { ConfigName: 'app-yaml__v1', File: { Name: '/etc/app.yaml', UID: '0', GID: '0', Mode: 0o444 } },
    ];
    const { ctx, deployed } = fakeCtx({
      services: [appInfo({ configs: ['proxy-conf', 'app-yaml__v1'] })],
      inspect: liveInspect({ configs }),
      respond: (cmd) => (cmd === 'config.list' ? configList : {}),
    });
    await detachConfigFromService(ctx, { family: 'app-yaml', service: APP });
    const spec = deployed();
    expectCarried(spec);
    expect(spec.configs?.map((c) => c.source)).toEqual(['proxy-conf']);
  });
});

describe('service.updateService keeps what the caller did not re-specify', () => {
  it('an image-only update carries volume/command/placement/refs', async () => {
    const { ctx, deployed } = fakeCtx({ services: [appInfo()] });
    await updateService(ctx, { id: 'svc-api', image: 'ghcr.io/acme/api:1.3.0' });
    const spec = deployed();
    expect(spec.image).toBe('ghcr.io/acme/api:1.3.0');
    expectCarried(spec);
    expectTlsSecretKept(spec);
    expectProxyConfigKept(spec);
    expect(spec.env).toEqual({ LOG: 'debug' });
  });

  it('re-specified fields replace; unnamed placement parts survive', async () => {
    const { ctx, deployed } = fakeCtx({ services: [appInfo()] });
    await updateService(ctx, {
      id: 'svc-api',
      env: [{ key: 'A', value: '1' }],
      constraints: ['node.role==worker'],
      replicas: 4,
    });
    const spec = deployed();
    expect(spec.env).toEqual({ A: '1' });
    expect(spec.mode).toEqual({ replicated: { replicas: 4 } });
    expect(spec.placement).toEqual({
      constraints: ['node.role==worker'],
      preferences: ['spread=node.labels.zone'],
      maxReplicasPerNode: 1,
    });
    expect(spec.mounts).toEqual([{ type: 'volume', source: 'shop_data', target: '/data' }]);
    expect(spec.command).toEqual(['/app/server']);
  });
});
