import type { AgentHub } from '../hub/types';
import { seedKv } from './swarm-kv.service';
import { beforeEach, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import {
  DOCKER_HUB_SERVER,
  buildPullAuths,
  guessProvider,
  matchCredential,
  normalizeRegistryPrefix,
  parseAuthChallenge,
  parseImageRef,
  testRegistryLogin,
} from './registry-credentials';
import { invalidateRegistryCredentialCache, resolveRegistryAuthFor } from './registry-credentials.service';
import { attachBuildPullAuths, attachThirdPartyAuth, createRegistryAuthDecorator } from './registry-auth';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-registry-credentials-0123456789';

describe('normalizeRegistryPrefix', () => {
  const cases: [string, string | null][] = [
    ['ghcr.io', 'ghcr.io'],
    ['https://GHCR.io/acme/', 'ghcr.io/acme'],
    ['index.docker.io', 'docker.io'],
    ['https://index.docker.io/v1/', 'docker.io'],
    ['registry-1.docker.io/me', 'docker.io/me'],
    ['registry.gitlab.com/grp/sub', 'registry.gitlab.com/grp/sub'],
    ['123456789012.dkr.ecr.eu-west-1.amazonaws.com', '123456789012.dkr.ecr.eu-west-1.amazonaws.com'],
    ['localhost:5001', 'localhost:5001'],
    ['', null],
    ['nginx', null],
    ['ghcr.io//x', null],
    ['ghcr .io', null],
  ];
  for (const [input, want] of cases) it(`${JSON.stringify(input)} → ${want}`, () => expect(normalizeRegistryPrefix(input)).toBe(want));
});

describe('parseImageRef', () => {
  const cases: [string, { host: string; repo: string; reference: string }][] = [
    ['nginx', { host: 'docker.io', repo: 'library/nginx', reference: 'latest' }],
    ['nginx:1.27', { host: 'docker.io', repo: 'library/nginx', reference: '1.27' }],
    ['me/app:2', { host: 'docker.io', repo: 'me/app', reference: '2' }],
    ['docker.io/me/app', { host: 'docker.io', repo: 'me/app', reference: 'latest' }],
    ['ghcr.io/acme/web:1.2', { host: 'ghcr.io', repo: 'acme/web', reference: '1.2' }],
    ['localhost:5000/app@sha256:abc', { host: 'localhost:5000', repo: 'app', reference: 'sha256:abc' }],
    ['ghcr.io/acme/web:1@sha256:abc', { host: 'ghcr.io', repo: 'acme/web', reference: 'sha256:abc' }],
  ];
  for (const [img, want] of cases) it(img, () => expect(parseImageRef(img)).toEqual(want));
});

describe('matchCredential — longest prefix, segment-exact', () => {
  const creds = [
    { prefix: 'ghcr.io', id: 'ghcr' },
    { prefix: 'ghcr.io/acme', id: 'acme' },
    { prefix: 'docker.io', id: 'hub' },
    { prefix: 'registry.gitlab.com/grp', id: 'gl' },
  ];
  const cases: [string, string | null][] = [
    ['ghcr.io/acme/web:1', 'acme'],
    ['ghcr.io/acmecorp/web:1', 'ghcr'], // not a path-segment match for ghcr.io/acme
    ['ghcr.io/other/x', 'ghcr'],
    ['nginx:1.27', 'hub'],
    ['me/private:1', 'hub'],
    ['registry.gitlab.com/grp/app:1', 'gl'],
    ['registry.gitlab.com/grpx/app:1', null],
    ['quay.io/x/y', null],
  ];
  for (const [img, want] of cases) it(`${img} → ${want}`, () => expect(matchCredential(img, creds)?.id ?? null).toBe(want));
});

describe('buildPullAuths', () => {
  it('one entry per server, broadest prefix wins; Hub uses the index server address', () => {
    const out = buildPullAuths([
      { prefix: 'ghcr.io/acme', username: 'a', secret: '1' },
      { prefix: 'ghcr.io', username: 'b', secret: '2' },
      { prefix: 'docker.io', username: 'h', secret: '3' },
    ]);
    expect(out).toEqual([
      { username: 'b', password: '2', server: 'ghcr.io' },
      { username: 'h', password: '3', server: DOCKER_HUB_SERVER },
    ]);
  });
});

it('guessProvider', () => {
  expect(guessProvider('ghcr.io/acme')).toBe('ghcr');
  expect(guessProvider('docker.io')).toBe('dockerhub');
  expect(guessProvider('registry.gitlab.com')).toBe('gitlab');
  expect(guessProvider('1.dkr.ecr.us-east-1.amazonaws.com')).toBe('ecr');
  expect(guessProvider('europe-docker.pkg.dev/p')).toBe('gcr');
  expect(guessProvider('x.azurecr.io')).toBe('acr');
  expect(guessProvider('harbor.example.com')).toBe('generic');
});

it('parseAuthChallenge', () => {
  expect(parseAuthChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
    scheme: 'bearer',
    params: { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:a/b:pull' },
  });
  expect(parseAuthChallenge('Basic realm="Registry"')?.scheme).toBe('basic');
  expect(parseAuthChallenge(null)).toBeNull();
});

// ── testRegistryLogin against a scripted fake registry ──────────────────────

type Route = (url: URL, init: RequestInit) => Response;
function fakeFetch(route: Route) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    calls.push({ url, method: init.method ?? 'GET', auth: h.get('authorization') });
    return route(new URL(url), init);
  };
  return { f, calls };
}
const GOOD = `Basic ${Buffer.from('me:tok').toString('base64')}`;

function bearerRegistry(opts: { manifest: number }): Route {
  return (url, init) => {
    const auth = new Headers(init.headers).get('authorization');
    if (url.pathname === '/v2/') {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="https://auth.example/token",service="reg.example"' },
      });
    }
    if (url.host === 'auth.example') {
      return auth === GOOD ? Response.json({ token: 'T' }) : new Response('', { status: 401 });
    }
    if (url.pathname.includes('/manifests/')) {
      return new Response(null, { status: auth === 'Bearer T' ? opts.manifest : 401 });
    }
    return new Response('', { status: 500 });
  };
}

describe('testRegistryLogin', () => {
  it('Bearer dance + manifest HEAD → ok; scope + service passed to the realm', async () => {
    const { f, calls } = fakeFetch(bearerRegistry({ manifest: 200 }));
    const r = await testRegistryLogin({ prefix: 'reg.example', username: 'me', secret: 'tok', image: 'reg.example/acme/web:1' }, f);
    expect(r).toEqual({ ok: true, status: 'ok', message: 'can pull acme/web:1', checkedManifest: true });
    const tokenUrl = new URL(calls[1]!.url);
    expect(tokenUrl.searchParams.get('service')).toBe('reg.example');
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:acme/web:pull');
    expect(calls[2]).toMatchObject({ method: 'HEAD', url: 'https://reg.example/v2/acme/web/manifests/1' });
  });

  it('wrong token → unauthorized, secret never echoed', async () => {
    const { f } = fakeFetch(bearerRegistry({ manifest: 200 }));
    const r = await testRegistryLogin({ prefix: 'reg.example', username: 'me', secret: 'nope' }, f);
    expect(r.status).toBe('unauthorized');
    expect(r.message).not.toContain('nope');
  });

  it('missing image → not_found', async () => {
    const { f } = fakeFetch(bearerRegistry({ manifest: 404 }));
    const r = await testRegistryLogin({ prefix: 'reg.example', username: 'me', secret: 'tok', image: 'reg.example/x:9' }, f);
    expect(r.status).toBe('not_found');
  });

  it('Basic registry: retries /v2/ with the login', async () => {
    const { f, calls } = fakeFetch((url, init) => {
      const auth = new Headers(init.headers).get('authorization');
      if (url.pathname === '/v2/') {
        return auth === GOOD
          ? new Response('{}', { status: 200 })
          : new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } });
      }
      return new Response('', { status: 500 });
    });
    const r = await testRegistryLogin({ prefix: 'harbor.example.com', username: 'me', secret: 'tok' }, f);
    expect(r).toMatchObject({ ok: true, status: 'ok', checkedManifest: false });
    expect(calls).toHaveLength(2);
  });

  it('Docker Hub talks to registry-1.docker.io and resolves library/ shorthand', async () => {
    const { f, calls } = fakeFetch(bearerRegistry({ manifest: 200 }));
    await testRegistryLogin({ prefix: 'docker.io', username: 'me', secret: 'tok', image: 'nginx' }, f);
    expect(calls[0]!.url).toBe('https://registry-1.docker.io/v2/');
    expect(calls[2]!.url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest');
  });

  it('network failure → unreachable (never throws)', async () => {
    const r = await testRegistryLogin({ prefix: 'reg.example', username: 'me', secret: 'tok' }, async () => {
      throw new Error('ECONNREFUSED tok');
    });
    expect(r.status).toBe('unreachable');
    expect(r.message).not.toContain('tok');
  });

  it('image on a different host is refused before any request', async () => {
    const { f, calls } = fakeFetch(bearerRegistry({ manifest: 200 }));
    const r = await testRegistryLogin({ prefix: 'ghcr.io', username: 'me', secret: 'tok', image: 'quay.io/x/y' }, f);
    expect(r.status).toBe('error');
    expect(calls).toHaveLength(0);
  });
});

// ── Decorator: third-party creds on deploy/pull/build ────────────────────────

function fakeDb(rows: { prefix: string; username: string; secret: string }[], registryConfig: unknown = null) {
  let credLookups = 0;
  // The org registry config lives in the org's swarm (swarm-kv).
  const hub = {} as AgentHub;
  if (registryConfig) seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, ...(registryConfig as object) });
  const db = {
    registryCredential: {
      findMany: async () => {
        credLookups++;
        return rows.map((r) => ({ prefix: r.prefix, username: r.username, secretEnc: encryptSecret(r.secret) }));
      },
    },
  } as unknown as DB;
  return { db, hub, lookups: () => credLookups };
}

describe('registry-auth decorator × third-party credentials', () => {
  beforeEach(() => invalidateRegistryCredentialCache());

  it('attaches the longest-prefix login to service.deploy and image.pull', async () => {
    const { db } = fakeDb([
      { prefix: 'ghcr.io', username: 'broad', secret: 's1' },
      { prefix: 'ghcr.io/acme', username: 'acme', secret: 's2' },
      { prefix: 'docker.io', username: 'hub', secret: 's3' },
    ]);
    const decorate = createRegistryAuthDecorator(db);
    const dep = (await decorate('o1', 'service.deploy', { spec: { name: 'w', image: 'ghcr.io/acme/web:1' } })) as {
      registryAuth?: unknown;
    };
    expect(dep.registryAuth).toEqual({ username: 'acme', password: 's2', server: 'ghcr.io' });
    const pull = (await decorate('o1', 'image.pull', { image: 'me/private:1' })) as { registryAuth?: unknown };
    expect(pull.registryAuth).toEqual({ username: 'hub', password: 's3', server: DOCKER_HUB_SERVER });
  });

  it('no match → same payload reference; explicit registryAuth never overridden', async () => {
    const { db } = fakeDb([{ prefix: 'ghcr.io', username: 'u', secret: 's' }]);
    const decorate = createRegistryAuthDecorator(db);
    const quay = { spec: { name: 'x', image: 'quay.io/x/y:1' } };
    expect(await decorate('o1', 'service.deploy', quay)).toBe(quay);
    const explicit = { spec: { name: 'x', image: 'ghcr.io/a/b' }, registryAuth: { username: 'mine', password: 'p' } };
    expect(await decorate('o1', 'service.deploy', explicit)).toBe(explicit);
  });

  it('org-registry images keep the in-swarm login (third-party never consulted first)', async () => {
    const { db, hub } = fakeDb([{ prefix: 'localhost:5000', username: 'wrong', secret: 'x' }], {
      host: 'localhost:5000',
      credentialsEnc: encryptSecret(JSON.stringify({ username: 'swarmy', password: 'pw' })),
    });
    const out = (await createRegistryAuthDecorator(db, undefined, hub)('o1', 'service.deploy', {
      spec: { name: 'w', image: 'localhost:5000/app@sha256:' + 'a'.repeat(64) },
    })) as { registryAuth?: { username: string } };
    expect(out.registryAuth?.username).toBe('swarmy');
  });

  it('image.build gets every login as pullAuths', async () => {
    const { db } = fakeDb([
      { prefix: 'ghcr.io', username: 'g', secret: '1' },
      { prefix: 'docker.io', username: 'h', secret: '2' },
    ]);
    const out = (await createRegistryAuthDecorator(db)('o1', 'image.build', { imageRefs: ['x'] })) as {
      pullAuths?: { server?: string }[];
    };
    expect(out.pullAuths?.map((a) => a.server)).toEqual(['ghcr.io', DOCKER_HUB_SERVER]);
  });

  it('caches per org (one DB read across dispatches) and never touches other commands', async () => {
    const { db, lookups } = fakeDb([{ prefix: 'ghcr.io', username: 'u', secret: 's' }]);
    const decorate = createRegistryAuthDecorator(db);
    await decorate('o1', 'service.deploy', { spec: { name: 'a', image: 'ghcr.io/a/b' } });
    await decorate('o1', 'service.deploy', { spec: { name: 'b', image: 'nginx' } });
    const scale = { service: 'w', replicas: 2 };
    expect(await decorate('o1', 'service.scale', scale)).toBe(scale);
    expect(lookups()).toBe(1);
    expect((await resolveRegistryAuthFor(db, 'o1', 'ghcr.io/z/z'))?.username).toBe('u');
    expect(lookups()).toBe(1);
  });

  it('a DB failure fails open (payload untouched)', async () => {
    const db = {
      registryCredential: { findMany: async () => { throw new Error('db down'); } },
    } as unknown as DB;
    const p = { spec: { name: 'x', image: 'ghcr.io/a/b' } };
    expect(await createRegistryAuthDecorator(db)('o1', 'service.deploy', p)).toBe(p);
  });
});

describe('pure attach helpers', () => {
  it('attachThirdPartyAuth ignores non-pulling commands', () => {
    const p = { service: 'w' };
    expect(attachThirdPartyAuth('service.restart', p, [{ prefix: 'ghcr.io', username: 'u', secret: 's' }])).toBe(p);
  });
  it('attachBuildPullAuths keeps explicit entries per server', () => {
    const p = { pullAuths: [{ username: 'mine', password: 'p', server: 'ghcr.io' }] };
    const out = attachBuildPullAuths(p, [
      { username: 'org', password: 'x', server: 'ghcr.io' },
      { username: 'hub', password: 'y', server: DOCKER_HUB_SERVER },
    ]);
    expect(out.pullAuths.map((a) => a.username)).toEqual(['mine', 'hub']);
  });
});
