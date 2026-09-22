import { describe, expect, it } from 'bun:test';
import {
  DB_LAG_LABEL_PREFIX,
  lagLabelKey,
  parseLagLabels,
  pitrConfigName,
  resolveManagedPgImage,
  roVarName,
  walArchiveVolumeName,
  walShipperServiceName,
} from './manageddb.service';
import { DEFAULT_MANAGED_PG_IMAGE } from '@swarmy/core/protocol';

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
