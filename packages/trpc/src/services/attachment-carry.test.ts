import { describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { carryManagedAttachments, secretRefsFromInspect } from './attachment-carry';

/**
 * A compose redeploy rebuilds the spec from the file; the managed-data wiring
 * swarmy stamped on the live service (env + secret + overlay + markers) must
 * survive it, or the app silently loses its database.
 */

function live(partial: Partial<SwarmServiceInfo> & { name: string }): SwarmServiceInfo {
  return {
    id: `id-${partial.name}`,
    image: 'img:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    labels: {},
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...partial,
  } as SwarmServiceInfo;
}

const composeWeb = (over: Partial<ServiceSpec> = {}): ServiceSpec =>
  ({
    name: 'shop_web',
    image: 'web:2',
    env: { NODE_ENV: 'production' },
    labels: { 'com.docker.stack.namespace': 'shop' },
    networks: ['shop_default'],
    ...over,
  }) as ServiceSpec;

describe('carryManagedAttachments', () => {
  it('carries a managed-Postgres attach: both URLs, the cluster overlay, the markers', () => {
    const src = live({
      name: 'shop_web',
      labels: {
        'com.docker.stack.namespace': 'shop',
        'swarmy.db.inject': 'db',
        'swarmy.db.inject.var': 'DATABASE_URL',
      },
      env: [
        'NODE_ENV=staging',
        'DATABASE_URL=postgres://postgres:pw@shop_db-primary:5432/app',
        'DATABASE_RO_URL=postgres://postgres:pw@shop_db-replica:5432/app',
        'UNRELATED=1',
      ],
      networks: [{ name: 'shop_default', aliases: ['web'] }, { name: 'shop_db-net', aliases: [] }],
    });
    const out = carryManagedAttachments(composeWeb(), src);
    expect(out.env).toEqual({
      NODE_ENV: 'production', // compose wins
      DATABASE_URL: 'postgres://postgres:pw@shop_db-primary:5432/app',
      DATABASE_RO_URL: 'postgres://postgres:pw@shop_db-replica:5432/app',
    });
    expect(out.networks).toEqual(['shop_default', 'shop_db-net']);
    expect(out.labels).toEqual({
      'com.docker.stack.namespace': 'shop',
      'swarmy.db.inject': 'db',
      'swarmy.db.inject.var': 'DATABASE_URL',
    });
    expect(out.secrets).toBeUndefined();
  });

  it('carries a cache attach with its password secret (target derived from the *_FILE env)', () => {
    const src = live({
      name: 'shop_web',
      labels: {
        'com.docker.stack.namespace': 'shop',
        'swarmy.cache.inject': 'sessions',
        'swarmy.cache.inject.var': 'REDIS_URL',
      },
      env: [
        'REDIS_URL=redis://shop_sessions-cache:6379',
        'REDIS_PASSWORD_FILE=/run/secrets/swarmy-cache-shop_sessions-password',
      ],
      secrets: ['swarmy-cache-shop_sessions-password'],
    });
    const out = carryManagedAttachments(composeWeb(), src);
    expect(out.env?.REDIS_URL).toBe('redis://shop_sessions-cache:6379');
    expect(out.env?.REDIS_PASSWORD_FILE).toBe('/run/secrets/swarmy-cache-shop_sessions-password');
    expect(out.networks).toEqual(['shop_default', 'shop_sessions-cache-net']);
    // Default target (== source) is left implicit, exactly as the attach wrote it.
    expect(out.secrets).toEqual([{ source: 'swarmy-cache-shop_sessions-password' }]);
  });

  it('keeps a rotated bucket secret on its stable target and joins the store overlay', () => {
    const src = live({
      name: 'shop_web',
      labels: {
        'com.docker.stack.namespace': 'shop',
        'swarmy.s3.bucket': 'assets',
        'swarmy.s3.key': 'GK123',
        'swarmy.s3.secret': 'swarmy-s3-assets-v2',
      },
      env: [
        'S3_ENDPOINT=http://swarmy-garage:3900',
        'S3_REGION=swarmy',
        'S3_BUCKET=assets',
        'S3_ACCESS_KEY_ID=GK123',
        'S3_SECRET_ACCESS_KEY_FILE=/run/secrets/swarmy-s3-assets',
      ],
      secrets: ['swarmy-s3-assets-v2'],
    });
    const out = carryManagedAttachments(composeWeb(), src);
    expect(out.networks).toEqual(['shop_default', 'swarmy']);
    expect(out.secrets).toEqual([{ source: 'swarmy-s3-assets-v2', target: 'swarmy-s3-assets' }]);
    expect(Object.keys(out.env ?? {}).sort()).toEqual(
      ['NODE_ENV', 'S3_ACCESS_KEY_ID', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_SECRET_ACCESS_KEY_FILE'].sort(),
    );
  });

  it('prefers the exact inspect secret refs (uid/gid/mode) when the caller passes them', () => {
    const inspect = {
      Spec: {
        TaskTemplate: {
          ContainerSpec: {
            Secrets: [
              {
                SecretName: 'swarmy-cache-shop_sessions-password',
                File: { Name: 'swarmy-cache-shop_sessions-password', UID: '1000', GID: '1000', Mode: 256 },
              },
            ],
          },
        },
      },
    };
    const refs = secretRefsFromInspect(inspect);
    expect(refs).toEqual([
      { source: 'swarmy-cache-shop_sessions-password', target: 'swarmy-cache-shop_sessions-password', uid: '1000', gid: '1000', mode: 256 },
    ]);
    const src = live({
      name: 'shop_web',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.cache.inject': 'sessions' },
      env: ['REDIS_URL=redis://x:6379', 'REDIS_PASSWORD_FILE=/run/secrets/swarmy-cache-shop_sessions-password'],
    });
    expect(carryManagedAttachments(composeWeb(), src, { secretRefs: refs }).secrets).toEqual(refs);
    expect(secretRefsFromInspect(null)).toEqual([]);
  });

  it('a key the compose sets itself wins; a domain whose marker the compose sets is left alone', () => {
    const src = live({
      name: 'shop_web',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.inject': 'db' },
      env: ['DATABASE_URL=postgres://live', 'DATABASE_RO_URL=postgres://live-ro'],
    });
    const own = carryManagedAttachments(composeWeb({ env: { DATABASE_URL: 'postgres://mine' } }), src);
    expect(own.env).toEqual({ DATABASE_URL: 'postgres://mine', DATABASE_RO_URL: 'postgres://live-ro' });

    const declared = composeWeb({ labels: { 'swarmy.db.inject': 'other' } });
    expect(carryManagedAttachments(declared, src)).toBe(declared);
  });

  it('is a no-op (same reference) without any attach marker or live source', () => {
    const spec = composeWeb();
    const src = live({ name: 'shop_web', env: ['DATABASE_URL=postgres://hand-set'], networks: [{ name: 'x-net', aliases: [] }] });
    expect(carryManagedAttachments(spec, src)).toBe(spec);
    expect(carryManagedAttachments(spec, undefined)).toBe(spec);
  });

  it('never duplicates a network or secret the compose already declares', () => {
    const src = live({
      name: 'shop_web',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.vector.inject': 'emb', 'swarmy.vector.inject.var': 'QDRANT_URL' },
      env: ['QDRANT_URL=http://shop_emb-vector:6333', 'QDRANT_API_KEY_FILE=/run/secrets/swarmy-vector-shop_emb-key'],
      secrets: ['swarmy-vector-shop_emb-key'],
    });
    const spec = composeWeb({
      networks: ['shop_default', 'shop_emb-vector-net'],
      secrets: [{ source: 'swarmy-vector-shop_emb-key' }],
    });
    const out = carryManagedAttachments(spec, src);
    expect(out.networks).toEqual(['shop_default', 'shop_emb-vector-net']);
    expect(out.secrets).toEqual([{ source: 'swarmy-vector-shop_emb-key' }]);
    expect(out.env?.QDRANT_API_KEY_FILE).toBe('/run/secrets/swarmy-vector-shop_emb-key');
  });

  it('skips a secret the live service does not actually mount (would fail the deploy)', () => {
    const src = live({
      name: 'shop_web',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.search.inject': 'find', 'swarmy.search.inject.var': 'MEILI_HOST' },
      env: ['MEILI_HOST=http://shop_find-search:7700', 'MEILI_MASTER_KEY_FILE=/run/secrets/swarmy-search-shop_find-key'],
      secrets: ['something-else'],
    });
    const out = carryManagedAttachments(composeWeb(), src);
    expect(out.networks).toEqual(['shop_default', 'shop_find-search-net']);
    expect(out.secrets).toBeUndefined();
  });
});

describe('carryManagedAttachments — swarmy.yaml email: binding', () => {
  it('keeps the env keys the email binding set (listed on its marker label)', () => {
    const source = live({
      name: 'shop_web',
      labels: { 'swarmy.email.bind': JSON.stringify(['SMTP_HOST', 'SMTP_PORT', 'EMAIL_API_URL']) },
      env: ['SMTP_HOST=swarmy-mail', 'SMTP_PORT=587', 'EMAIL_API_URL=https://swarm.test/email/v1', 'OTHER=x'],
    });
    const out = carryManagedAttachments(composeWeb(), source);
    expect(out.env).toEqual({ NODE_ENV: 'production', SMTP_HOST: 'swarmy-mail', SMTP_PORT: '587', EMAIL_API_URL: 'https://swarm.test/email/v1' });
    expect(out.labels?.['swarmy.email.bind']).toBe(source.labels['swarmy.email.bind']);
  });

  it('a malformed marker carries nothing but the marker', () => {
    const out = carryManagedAttachments(composeWeb(), live({ name: 'shop_web', labels: { 'swarmy.email.bind': '{nope' }, env: ['SMTP_HOST=x'] }));
    expect(out.env).toEqual({ NODE_ENV: 'production' });
  });
});
