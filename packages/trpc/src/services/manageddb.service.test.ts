import { describe, expect, it } from 'bun:test';
import {
  DB_LAG_LABEL_PREFIX,
  lagLabelKey,
  managedPgSpecs,
  parseLagLabels,
  pitrConfigName,
  rebuildDbMemberSpec,
  resolveManagedPgImage,
  roVarName,
  walArchiveVolumeName,
  walShipperServiceName,
} from './manageddb.service';
import { DEFAULT_MANAGED_PG_IMAGE } from '@swarmy/core/protocol';
import { primaryDataVolumeName, replicaDataVolumeName } from '@swarmy/core';

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
  it('defaults to the pinned, still-published bitnamilegacy image', () => {
    expect(resolveManagedPgImage({})).toBe('bitnamilegacy/postgresql:16');
    expect(DEFAULT_MANAGED_PG_IMAGE).toBe('bitnamilegacy/postgresql:16');
  });

  it('never emits the dead free-tier bitnami/postgresql namespace', () => {
    expect(resolveManagedPgImage({}, 'bitnami/postgresql:16')).toBe('bitnamilegacy/postgresql:16');
    expect(resolveManagedPgImage({ image: 'bitnami/postgresql:17' })).toBe(
      'bitnamilegacy/postgresql:17',
    );
  });

  it('imageTag picks a tag of the managed repo', () => {
    expect(resolveManagedPgImage({ imageTag: '17' })).toBe('bitnamilegacy/postgresql:17');
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
    image: 'bitnamilegacy/postgresql:16',
    password: 'pw',
    database: 'app',
    replicas: 2,
    dataVolume: primaryDataVolumeName('hello', 'main'),
    replicaVolume: replicaDataVolumeName('hello', 'main'),
    pinNode: 'swarmnode1',
    multiNode: true,
  });

  it('primary: named volume at /bitnami/postgresql + node.id pin + swarmy.db.* storage labels', () => {
    expect(primarySpec.mounts).toEqual([
      { type: 'volume', source: 'hello_main-primary-data', target: '/bitnami/postgresql' },
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
      { type: 'volume', source: 'hello_main-replica-data', target: '/bitnami/postgresql' },
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

  it('single-node swarm: replica has no anti-affinity (would be unschedulable)', () => {
    const single = managedPgSpecs({
      stack: 'hello',
      cluster: 'main',
      image: 'i',
      password: 'pw',
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
      password: 'pw',
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
        env: ['POSTGRESQL_PASSWORD=pw'],
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
      target: '/bitnami/postgresql',
    });
    expect(spec.placement?.constraints).toEqual(['node.id==n1']);
    expect(spec.env).toEqual({ POSTGRESQL_PASSWORD: 'pw' });
    expect(spec.networks).toEqual(['hello_main-net']);
  });
});
