import { describe, expect, it } from 'bun:test';
process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-registry-auth';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import {
  REGISTRY_AUTH_LABEL,
  attachRegistryAuth,
  createRegistryAuthDecorator,
  decodeRegistryCreds,
  generateRegistryCreds,
  htpasswdSecretName,
  registryAuthConverged,
  registryServiceSpec,
  renderHtpasswd,
} from './registry-auth';
import { convergeRegistryAuth, getRegistryConfig, rotateRegistryCredentials, setRegistryEnabled } from './cicd.service';

const CREDS = { username: 'swarmy', password: 'correct-horse-battery-staple' };
const ORG_IMG = 'localhost:5000/acme-web@sha256:' + 'c'.repeat(64);

describe('htpasswd render', () => {
  it('renders `user:<bcrypt>` that verifies the password (and rejects others)', async () => {
    const line = await renderHtpasswd(CREDS);
    expect(line.endsWith('\n')).toBe(true);
    const [user, hash] = line.trim().split(/:(.*)/s);
    expect(user).toBe('swarmy');
    expect(hash).toMatch(/^\$2[aby]\$10\$/); // registry:2 requires bcrypt
    expect(await Bun.password.verify(CREDS.password, hash!, 'bcrypt')).toBe(true);
    expect(await Bun.password.verify('wrong', hash!, 'bcrypt')).toBe(false);
  });

  it('generates a strong swarmy login', () => {
    const a = generateRegistryCreds();
    const b = generateRegistryCreds();
    expect(a.username).toBe('swarmy');
    expect(a.password.length).toBeGreaterThanOrEqual(43); // 256 bits base64url
    expect(a.password).not.toBe(b.password);
  });

  it('secret name is content-addressed on the login (stable, rotates with it)', () => {
    expect(htpasswdSecretName(CREDS)).toBe(htpasswdSecretName({ ...CREDS }));
    expect(htpasswdSecretName(CREDS)).toMatch(/^swarmy-registry-htpasswd-[0-9a-f]{16}$/);
    expect(htpasswdSecretName({ ...CREDS, password: 'rotated' })).not.toBe(htpasswdSecretName(CREDS));
  });

  it('decodes stored creds and tolerates garbage', () => {
    expect(decodeRegistryCreds(encryptSecret(JSON.stringify(CREDS)))).toEqual(CREDS);
    expect(decodeRegistryCreds(null)).toBeNull();
    expect(decodeRegistryCreds('not-ciphertext')).toBeNull();
  });
});

describe('registry service spec (golden)', () => {
  it('enforces htpasswd auth from a mounted secret, stays on the routing mesh at :5000', () => {
    expect(registryServiceSpec('swarmy-registry-htpasswd-0123456789abcdef')).toEqual({
      name: 'swarmy-registry',
      image: 'registry:2',
      mode: { replicated: { replicas: 1 } },
      labels: { 'swarmy.managed': 'true', 'swarmy.registry.auth': 'swarmy-registry-htpasswd-0123456789abcdef' },
      env: {
        REGISTRY_AUTH: 'htpasswd',
        REGISTRY_AUTH_HTPASSWD_REALM: 'swarmy-registry',
        REGISTRY_AUTH_HTPASSWD_PATH: '/run/secrets/registry-htpasswd',
        REGISTRY_STORAGE_DELETE_ENABLED: 'true',
      },
      secrets: [{ source: 'swarmy-registry-htpasswd-0123456789abcdef', target: 'registry-htpasswd', mode: 0o444 }],
      ports: [{ target: 5000, published: 5000, protocol: 'tcp', mode: 'ingress' }],
      networks: ['swarmy'],
      mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
    });
  });

  it('converged only when the live service runs auth with THIS secret', () => {
    const name = htpasswdSecretName(CREDS);
    const live = liveRegistry({ [REGISTRY_AUTH_LABEL]: name }, ['REGISTRY_AUTH=htpasswd'], [name]);
    expect(registryAuthConverged(live, name)).toBe(true);
    expect(registryAuthConverged(liveRegistry({}, [], []), name)).toBe(false); // pre-auth install
    expect(registryAuthConverged(live, htpasswdSecretName({ ...CREDS, password: 'x' }))).toBe(false); // rotated
  });
});

describe('deploy payload registry auth', () => {
  it('attaches creds to service.deploy of an org-registry image', () => {
    const out: unknown = attachRegistryAuth('service.deploy', { spec: { name: 'web', image: ORG_IMG } }, 'localhost:5000', CREDS);
    expect(out).toEqual({
      spec: { name: 'web', image: ORG_IMG },
      registryAuth: { username: 'swarmy', password: CREDS.password, server: 'localhost:5000' },
    });
  });

  it('also covers the legacy overlay host and image.pull', () => {
    const legacy = attachRegistryAuth(
      'service.deploy',
      { spec: { name: 'web', image: 'swarmy-registry:5000/app:main' } },
      'localhost:5000',
      CREDS,
    ) as { registryAuth?: unknown };
    expect(legacy.registryAuth).toBeDefined();
    const pull = attachRegistryAuth('image.pull', { image: ORG_IMG }, 'localhost:5000', CREDS) as { registryAuth?: unknown };
    expect(pull.registryAuth).toBeDefined();
  });

  it('does NOT attach creds to public images or other commands', () => {
    for (const image of ['nginx:1.27', 'ghcr.io/acme/web:1', 'localhost:5001/other:1', 'registry:2']) {
      const p = { spec: { name: 'x', image } };
      expect(attachRegistryAuth('service.deploy', p, 'localhost:5000', CREDS)).toBe(p);
    }
    const scale = { service: 'web', replicas: 2 };
    expect(attachRegistryAuth('service.scale', scale, 'localhost:5000', CREDS)).toBe(scale);
  });

  it('never overrides an explicit registryAuth', () => {
    const p = { spec: { name: 'web', image: ORG_IMG }, registryAuth: { username: 'u', password: 'p' } };
    expect(attachRegistryAuth('service.deploy', p, 'localhost:5000', CREDS)).toBe(p);
  });

  it('hub decorator: looks up the org login and attaches only for org-registry images', async () => {
    let lookups = 0;
    const db = {
      registryConfig: {
        findUnique: async () => {
          lookups++;
          return { host: 'localhost:5000', credentialsEnc: encryptSecret(JSON.stringify(CREDS)) };
        },
      },
    } as unknown as DB;
    const decorate = createRegistryAuthDecorator(db);
    const org = (await decorate('org1', 'service.deploy', { spec: { name: 'web', image: ORG_IMG } })) as {
      registryAuth?: { password: string };
    };
    expect(org.registryAuth?.password).toBe(CREDS.password);
    // Hub images (no registry host) never touch the DB.
    const pub = { spec: { name: 'db', image: 'postgres:17' } };
    expect(await decorate('org1', 'service.deploy', pub)).toBe(pub);
    expect(lookups).toBe(1);
    const ghcr = { spec: { name: 'x', image: 'ghcr.io/acme/x:1' } };
    expect(await decorate('org1', 'service.deploy', ghcr)).toBe(ghcr);
  });

  it('hub decorator: no stored login → payload untouched', async () => {
    const db = { registryConfig: { findUnique: async () => ({ host: null, credentialsEnc: null }) } } as unknown as DB;
    const p = { spec: { name: 'web', image: ORG_IMG } };
    expect(await createRegistryAuthDecorator(db)('org1', 'service.deploy', p)).toBe(p);
  });
});

// ── Service flow: enable / converge / rotate against a fake ctx ──────────────

function liveRegistry(labels: Record<string, string>, env: string[], secrets: string[]): SwarmServiceInfo {
  return {
    id: 'reg',
    name: 'swarmy-registry',
    image: 'registry:2',
    mode: 'replicated',
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels,
    networks: [],
    env,
    ports: [],
    secrets,
    configs: [],
  } as unknown as SwarmServiceInfo;
}

function fakeCtx(init: { enabled: boolean; credentialsEnc: string | null; services?: SwarmServiceInfo[] }) {
  const row = { enabled: init.enabled, host: 'localhost:5000', credentialsEnc: init.credentialsEnc, updatedAt: new Date() };
  const dispatched: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const audits: string[] = [];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      registryConfig: {
        upsert: async () => row,
        update: async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data),
      },
      auditLog: { create: async ({ data }: { data: { action: string } }) => audits.push(data.action) },
    },
    hub: {
      isOnline: () => true,
      managerNode: () => 'mgr1',
      liveInventory: () => ({ services: init.services ?? [], containers: [] }),
      dispatch: async (_node: string, cmd: string, payload: Record<string, unknown>) => {
        dispatched.push({ cmd, payload });
        if (cmd === 'secret.list') return { secrets: [{ name: 'swarmy-registry-htpasswd-stale000000000' }] };
        if (cmd === 'service.inspect') return { inspect: { Spec: { Name: payload.service, TaskTemplate: { ContainerSpec: {} } } } };
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, row, dispatched, audits };
}

describe('registry enable / converge / rotate', () => {
  it('enable mints a login, stores it encrypted, and deploys the registry with auth + secret', async () => {
    const { ctx, row, dispatched } = fakeCtx({ enabled: false, credentialsEnc: null });
    const view = await setRegistryEnabled(ctx, { enabled: true });
    const creds = JSON.parse(decryptSecret(row.credentialsEnc!)) as { username: string; password: string };
    expect(creds.username).toBe('swarmy');
    const secretName = htpasswdSecretName(creds);

    const create = dispatched.find((d) => d.cmd === 'secret.create')!;
    expect(create.payload.name).toBe(secretName);
    const htpasswd = Buffer.from(create.payload.dataB64 as string, 'base64').toString('utf8');
    expect(await Bun.password.verify(creds.password, htpasswd.trim().split(/:(.*)/s)[1]!, 'bcrypt')).toBe(true);

    const deploy = dispatched.find((d) => d.cmd === 'service.deploy')!;
    expect(deploy.payload.spec).toEqual(registryServiceSpec(secretName));
    // Superseded htpasswd secrets are cleaned up; the current one is kept.
    expect(dispatched.filter((d) => d.cmd === 'secret.remove').map((d) => d.payload.name)).toEqual([
      'swarmy-registry-htpasswd-stale000000000',
    ]);

    // The view never carries the password.
    expect(view.login).toBe('auto-generated');
    expect(view.username).toBe('swarmy');
    expect(JSON.stringify(view)).not.toContain(creds.password);
  });

  it('re-enable reuses the stored login (no churn)', async () => {
    const enc = encryptSecret(JSON.stringify(CREDS));
    const { ctx, row, dispatched } = fakeCtx({ enabled: false, credentialsEnc: enc });
    await setRegistryEnabled(ctx, { enabled: true });
    expect(row.credentialsEnc).toBe(enc);
    expect(dispatched.find((d) => d.cmd === 'secret.create')!.payload.name).toBe(htpasswdSecretName(CREDS));
  });

  it('converge closes an open (pre-auth) registry and re-auths org-registry services', async () => {
    const web = { ...liveRegistry({}, [], []), id: 'w', name: 'web', image: ORG_IMG } as SwarmServiceInfo;
    const nginx = { ...liveRegistry({}, [], []), id: 'n', name: 'nginx', image: 'nginx:1.27' } as SwarmServiceInfo;
    const { ctx, row, dispatched, audits } = fakeCtx({
      enabled: true,
      credentialsEnc: null,
      services: [liveRegistry({}, [], []), web, nginx],
    });
    expect(await convergeRegistryAuth(ctx)).toBe('converged');
    expect(row.credentialsEnc).not.toBeNull();
    const deployed = dispatched.filter((d) => d.cmd === 'service.deploy').map((d) => (d.payload.spec as { name: string }).name);
    expect(deployed).toEqual(['swarmy-registry', 'web']); // nginx (public image) untouched
    expect(audits).toContain('cicd.registry.authConverge');
  });

  it('converge is a no-op once the live registry runs the stored login', async () => {
    const name = htpasswdSecretName(CREDS);
    const { ctx, dispatched } = fakeCtx({
      enabled: true,
      credentialsEnc: encryptSecret(JSON.stringify(CREDS)),
      services: [liveRegistry({ [REGISTRY_AUTH_LABEL]: name }, ['REGISTRY_AUTH=htpasswd'], [name])],
    });
    expect(await convergeRegistryAuth(ctx)).toBe('noop');
    expect(dispatched).toEqual([]);
    const view = await getRegistryConfig(ctx);
    expect(view.authEnforced).toBe(true);
  });

  it('converge skips a disabled registry', async () => {
    const { ctx, dispatched } = fakeCtx({ enabled: false, credentialsEnc: null });
    expect(await convergeRegistryAuth(ctx)).toBe('skipped');
    expect(dispatched).toEqual([]);
  });

  it('rotate mints a new login and a new content-addressed secret', async () => {
    const { ctx, row, dispatched, audits } = fakeCtx({ enabled: true, credentialsEnc: encryptSecret(JSON.stringify(CREDS)) });
    await rotateRegistryCredentials(ctx);
    const next = JSON.parse(decryptSecret(row.credentialsEnc!)) as { password: string };
    expect(next.password).not.toBe(CREDS.password);
    const secret = dispatched.find((d) => d.cmd === 'secret.create')!.payload.name;
    expect(secret).not.toBe(htpasswdSecretName(CREDS));
    expect(audits).toContain('cicd.registry.rotate');
  });
});
