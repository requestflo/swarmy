import { describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { pitrPrimarySpec, preparePitrPrimary } from './manageddb-pitr.core';
import {
  consumersNeedCredentialMigration,
  extraPrimarySpec,
  needsCredentialMigration,
  placePrimarySpec,
  regionReplicaSpec,
  repointSpec,
  stripPitrSpec,
} from './manageddb-reconcile';

/**
 * Security: every member spec the reconcile builds — geo siblings, extra
 * primaries, the failover repoint, the PITR primary rewrite and strip, a geo
 * re-placement — delivers the password as the mounted Docker secret file and
 * never as plaintext env. Live truth reports secret NAMES only (no targets),
 * so the rebuild must still mount the family path the `_FILE` env points at.
 */

const SECRET = 'shop_main-pg-password__v3';
const FILE = '/run/secrets/shop_main-pg-password';

const svc = (over: Partial<SwarmServiceInfo> & { name: string }): SwarmServiceInfo =>
  ({
    id: `id-${over.name}`,
    image: 'pgvector/pgvector:pg17',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    networks: [{ name: 'shop_main-net', aliases: [] }],
    ports: [],
    configs: [],
    ...over,
  }) as SwarmServiceInfo;

const primary = svc({
  name: 'shop_main-primary',
  labels: {
    'com.docker.stack.namespace': 'shop',
    'swarmy.db.cluster': 'main',
    'swarmy.db.role': 'primary',
    'swarmy.db.passwordSecret': SECRET,
    'swarmy.db.dataVolume': 'shop_main-primary-data',
    'swarmy.db.node': 'swarm-a',
  },
  env: [
    'SWARMY_PG_ROLE=primary',
    `POSTGRES_PASSWORD_FILE=${FILE}`,
    'POSTGRES_DB=app',
    'SWARMY_PG_REPLICATION_USER=repl',
    `SWARMY_PG_REPLICATION_PASSWORD_FILE=${FILE}`,
  ],
  secrets: [SECRET],
});
const cluster = {
  stack: 'shop',
  cluster: 'main',
  base: 'shop_main',
  primary,
  extraPrimaries: new Map(),
  regionReplicas: new Map(),
};

const expectSecretBacked = (spec: ServiceSpec) => {
  expect(spec.env?.POSTGRES_PASSWORD).toBeUndefined();
  expect(spec.env?.SWARMY_PG_REPLICATION_PASSWORD).toBeUndefined();
  expect(spec.env?.POSTGRES_PASSWORD_FILE).toBe(FILE);
  expect(spec.env?.SWARMY_PG_REPLICATION_PASSWORD_FILE).toBe(FILE);
  expect(spec.secrets).toContainEqual({ source: SECRET, target: 'shop_main-pg-password' });
  expect(spec.secrets?.filter((r) => r.source.includes('-pg-password'))).toHaveLength(1);
};

describe('reconcile member specs keep the password a secret file', () => {
  it('geo region sibling + active-active extra primary', () => {
    expectSecretBacked(regionReplicaSpec(cluster as never, primary, 'eu', 1, true));
    expectSecretBacked(extraPrimarySpec(cluster as never, primary, 2, 'swarm-b'));
  });

  it('failover repoint of a replica (and of the demoted ex-writer)', () => {
    const spec = repointSpec(primary, 'shop_main-replica', 'shop_main-net', 'epoch-1');
    expectSecretBacked(spec);
    expect(spec.env?.SWARMY_PG_ROLE).toBe('replica');
    expect(spec.env?.SWARMY_PG_PRIMARY_HOST).toBe('shop_main-replica');
  });

  it('PITR apply/strip, a promoted-replica writer rewrite, and a geo re-placement', () => {
    expectSecretBacked(pitrPrimarySpec(primary, { base: 'shop_main' }, 'shop_main-net', '1', 'shop_main-primary-data'));
    expectSecretBacked(stripPitrSpec(primary, cluster as never));
    expectSecretBacked(placePrimarySpec(primary, 'eu', 'shop_main-net'));
    const promoted = svc({ ...primary, name: 'shop_main-replica', env: [...primary.env!.filter((e) => !e.startsWith('SWARMY_PG_ROLE')), 'SWARMY_PG_ROLE=replica'] });
    const prep = preparePitrPrimary(promoted, 'swarm-a');
    expect(prep.kind).toBe('ready');
    if (prep.kind === 'ready') expectSecretBacked(pitrPrimarySpec(prep.primary, { base: 'shop_main' }, 'shop_main-net', '1', undefined));
  });

  it('needsCredentialMigration spots a plain-env member only', () => {
    expect(needsCredentialMigration(cluster as never)).toBe(false);
    const legacy = svc({ name: 'shop_main-replica', labels: {}, env: ['POSTGRES_PASSWORD=plain'] });
    expect(needsCredentialMigration({ ...cluster, replica: legacy } as never)).toBe(true);
  });
});

describe('QA-084b: the tick gate sees apps, not only members', () => {
  it('a migrated cluster + an app with plaintext DATABASE_URL still needs a pass; a re-wired app does not', () => {
    const legacyApp = svc({
      name: 'shop_web',
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.inject': 'main', 'swarmy.db.inject.var': 'DATABASE_URL' },
      env: ['DATABASE_URL=postgres://postgres:pw@shop_main-primary:5432/app'],
    });
    expect(needsCredentialMigration(cluster as never)).toBe(false);
    expect(consumersNeedCredentialMigration([primary, legacyApp], cluster)).toBe(true);
    const rewired = svc({ ...legacyApp, env: ['SWARMY_SECRET_ENV=DATABASE_RO_URL,DATABASE_URL'], secrets: ['shop_main-pg-url__v3'] });
    expect(consumersNeedCredentialMigration([primary, rewired], cluster)).toBe(false);
    // Another stack's app with the same cluster name is not this cluster's.
    const other = svc({ ...legacyApp, labels: { ...legacyApp.labels, 'com.docker.stack.namespace': 'blog' } });
    expect(consumersNeedCredentialMigration([other], cluster)).toBe(false);
  });
});
