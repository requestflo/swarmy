import { describe, expect, it } from 'bun:test';
import {
  DB_LAG_LABEL_PREFIX,
  lagLabelKey,
  managedPgSpecs,
  parseLagLabels,
  pitrConfigName,
  rebuildDbMemberSpec,
  isBitnamiImage,
  resolveManagedPgImage,
  roVarName,
  walArchiveVolumeName,
  walShipperServiceName,
} from './manageddb.service';
import { DEFAULT_MANAGED_PG_IMAGE } from '@swarmy/core/protocol';
import { pgBootCommand, primaryDataVolumeName, replicaDataVolumeName } from '@swarmy/core';

describe('lag labels (swarmy.db.lag.<member>) — codec', () => {
  it('round-trips a stamped member lag', () => {
    const key = lagLabelKey('shop_main-replica');
    expect(key).toBe(`${DB_LAG_LABEL_PREFIX}shop_main-replica`);
    expect(parseLagLabels({ [key]: '0.4' })).toEqual({ 'shop_main-replica': 0.4 });
  });

  it('parses multiple members off one anchor label set', () => {
    const labels = {
      'swarmy.db.lag.shop_main-replica': '1.5',
      'swarmy.db.lag.shop_main-replica-eu-west': '12',
      'swarmy.db.engine': 'postgres',
    };
    expect(parseLagLabels(labels)).toEqual({
      'shop_main-replica': 1.5,
      'shop_main-replica-eu-west': 12,
    });
  });

  it('drops malformed, negative and empty-member entries', () => {
    expect(
      parseLagLabels({
        'swarmy.db.lag.a': 'not-a-number',
        'swarmy.db.lag.b': '-3',
        'swarmy.db.lag.': '5',
        'swarmy.db.lag.c': '0',
      }),
    ).toEqual({ c: 0 });
  });

  it('tolerates undefined labels', () => {
    expect(parseLagLabels(undefined)).toEqual({});
  });
});

describe('PITR resource names — derive from <stack>_<cluster>', () => {
  it('names the wal-shipper, archive volume and conf per cluster', () => {
    expect(walShipperServiceName('shop', 'main')).toBe('shop_main-wal-shipper');
    expect(walArchiveVolumeName('shop', 'main')).toBe('shop_main-wal-archive');
    expect(pitrConfigName('shop', 'main')).toBe('shop_main-pitr-conf');
  });
});

describe('roVarName — read-only env var derivation (existing behaviour)', () => {
  it('rewrites *_URL and suffixes everything else', () => {
    expect(roVarName('DATABASE_URL')).toBe('DATABASE_RO_URL');
    expect(roVarName('PG')).toBe('PG_RO');
  });
});

describe('resolveManagedPgImage — engine image default + per-cluster override', () => {
  it('defaults to the official-postgres + pgvector image (no Bitnami)', () => {
    expect(resolveManagedPgImage({})).toBe('pgvector/pgvector:pg17');
    expect(DEFAULT_MANAGED_PG_IMAGE).toBe('pgvector/pgvector:pg17');
  });

  it('never carries a live Bitnami engine forward (different env/path contract)', () => {
    expect(resolveManagedPgImage({}, 'bitnamilegacy/postgresql:16')).toBe('pgvector/pgvector:pg17');
    expect(resolveManagedPgImage({}, 'bitnami/postgresql:16@sha256:abc')).toBe('pgvector/pgvector:pg17');
    expect(isBitnamiImage('docker.io/bitnamilegacy/postgresql:16')).toBe(true);
    expect(isBitnamiImage('postgres:17')).toBe(false);
  });

  it('imageTag picks a tag of the managed repo (bare major → pgNN)', () => {
    expect(resolveManagedPgImage({ imageTag: '16' })).toBe('pgvector/pgvector:pg16');
    expect(resolveManagedPgImage({ imageTag: 'pg17-bookworm' })).toBe('pgvector/pgvector:pg17-bookworm');
  });

  it('explicit image wins over imageTag and the live image', () => {
    expect(
      resolveManagedPgImage({ image: 'mirror.local/pg:16', imageTag: '17' }, 'x/y:1'),
    ).toBe('mirror.local/pg:16');
  });

  it('re-provision keeps a live per-cluster override, minus any digest pin', () => {
    expect(resolveManagedPgImage({}, 'mirror.local/pg:16@sha256:abc')).toBe('mirror.local/pg:16');
  });
});

describe('managedPgSpecs — persistent storage layout golden', () => {
  const { primarySpec, replicaSpec } = managedPgSpecs({
    stack: 'hello',
    cluster: 'main',
    image: 'pgvector/pgvector:pg17',
    passwordSecret: 'hello_main-pg-password__v1',
    database: 'app',
    replicas: 2,
    dataVolume: primaryDataVolumeName('hello', 'main'),
    replicaVolume: replicaDataVolumeName('hello', 'main'),
    pinNode: 'swarmnode1',
    multiNode: true,
  });

  it('primary: named volume at the data root + node.id pin + swarmy.db.* storage labels', () => {
    expect(primarySpec.mounts).toEqual([
      { type: 'volume', source: 'hello_main-primary-data', target: '/var/lib/postgresql/data' },
    ]);
    expect(primarySpec.placement).toEqual({
      constraints: ['node.id==swarmnode1'],
      maxReplicasPerNode: 1,
    });
    expect(primarySpec.labels).toMatchObject({
      'swarmy.db.role': 'primary',
      'swarmy.db.dataVolume': 'hello_main-primary-data',
      'swarmy.db.node': 'swarmnode1',
    });
    expect(primarySpec.mode).toEqual({ replicated: { replicas: 1 } });
  });

  it('replica: per-node volume + anti-affinity from the primary node + one task per node', () => {
    expect(replicaSpec.mounts).toEqual([
      { type: 'volume', source: 'hello_main-replica-data', target: '/var/lib/postgresql/data' },
    ]);
    expect(replicaSpec.placement).toEqual({
      constraints: ['node.id!=swarmnode1'],
      maxReplicasPerNode: 1,
    });
    expect(replicaSpec.labels).toMatchObject({
      'swarmy.db.role': 'replica',
      'swarmy.db.dataVolume': 'hello_main-replica-data',
      'swarmy.db.avoidNode': 'swarmnode1',
    });
    expect(replicaSpec.labels?.['swarmy.db.node']).toBeUndefined();
  });

  it('boot layer: swarmy entrypoint + official POSTGRES_* / SWARMY_PG_* env, no Bitnami names', () => {
    for (const spec of [primarySpec, replicaSpec]) {
      expect(spec.command).toEqual(pgBootCommand());
      expect(spec.args).toBeUndefined();
      expect(JSON.stringify(spec.env)).not.toContain('POSTGRESQL_');
    }
    // The password is a Docker secret FILE — no member env carries a value.
    const file = '/run/secrets/hello_main-pg-password';
    expect(primarySpec.env).toEqual({
      SWARMY_PG_ROLE: 'primary',
      POSTGRES_PASSWORD_FILE: file,
      POSTGRES_DB: 'app',
      PGDATA: '/var/lib/postgresql/data/pgdata',
      SWARMY_PG_REPLICATION_USER: 'repl',
      SWARMY_PG_REPLICATION_PASSWORD_FILE: file,
    });
    expect(replicaSpec.env).toEqual({
      SWARMY_PG_ROLE: 'replica',
      POSTGRES_PASSWORD_FILE: file,
      PGDATA: '/var/lib/postgresql/data/pgdata',
      SWARMY_PG_REPLICATION_USER: 'repl',
      SWARMY_PG_REPLICATION_PASSWORD_FILE: file,
      SWARMY_PG_PRIMARY_HOST: 'hello_main-primary',
      SWARMY_PG_PRIMARY_PORT: '5432',
    });
    for (const spec of [primarySpec, replicaSpec]) {
      expect(spec.secrets).toEqual([{ source: 'hello_main-pg-password__v1', target: 'hello_main-pg-password' }]);
      expect(spec.labels?.['swarmy.db.passwordSecret']).toBe('hello_main-pg-password__v1');
    }
  });

  it('single-node swarm: replica has no anti-affinity (would be unschedulable)', () => {
    const single = managedPgSpecs({
      stack: 'hello',
      cluster: 'main',
      image: 'i',
      passwordSecret: 'hello_main-pg-password__v1',
      database: 'app',
      replicas: 1,
      dataVolume: 'hello_main-primary-data',
      replicaVolume: 'hello_main-replica-data',
      pinNode: 'n1',
      multiNode: false,
    });
    expect(single.replicaSpec.placement).toEqual({ maxReplicasPerNode: 1 });
  });

  it('re-provision carries declared labels but drops the PITR marker and keeps the topology', () => {
    const again = managedPgSpecs({
      stack: 'hello',
      cluster: 'main',
      image: 'i',
      passwordSecret: 'hello_main-pg-password__v1',
      database: 'app',
      replicas: 1,
      dataVolume: 'hello_main-primary-data',
      replicaVolume: 'hello_main-replica-data',
      pinNode: 'n1',
      multiNode: true,
      carryLabels: {
        'swarmy.db.backup.schedule': '{"cron":"0 3 * * *"}',
        'swarmy.db.topology': 'failover',
      },
    });
    expect(again.primarySpec.labels?.['swarmy.db.backup.schedule']).toBe('{"cron":"0 3 * * *"}');
    expect(again.primarySpec.labels?.['swarmy.db.topology']).toBe('failover');
  });
});

describe('rebuildDbMemberSpec — never a bare spec', () => {
  it('re-derives mount + pin from the member labels', () => {
    const spec = rebuildDbMemberSpec(
      {
        id: 'x',
        name: 'hello_main-primary',
        image: 'i',
        mode: 'replicated',
        runningReplicas: 0,
        createdAt: 0,
        updatedAt: 0,
        labels: {},
        networks: [{ name: 'hello_main-net', aliases: [] }],
        env: ['POSTGRES_PASSWORD=pw'],
        ports: [],
        secrets: [],
        configs: [],
        mounts: [],
      },
      { 'swarmy.db.dataVolume': 'hello_main-primary-data', 'swarmy.db.node': 'n1' },
      1,
    );
    expect(spec.mounts?.[0]).toEqual({
      type: 'volume',
      source: 'hello_main-primary-data',
      target: '/var/lib/postgresql/data',
    });
    expect(spec.placement?.constraints).toEqual(['node.id==n1']);
    // The live inventory carries no command: the rebuild re-stamps the boot layer.
    expect(spec.command).toEqual(pgBootCommand());
    expect(spec.env).toEqual({ POSTGRES_PASSWORD: 'pw', PGDATA: '/var/lib/postgresql/data/pgdata' });
    expect(spec.networks).toEqual(['hello_main-net']);
  });
});
