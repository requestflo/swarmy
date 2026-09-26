import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { carrySecretFamilies, mountsSecretFamily } from './secret-family-carry';

describe('carrySecretFamilies (QA-073 follow-up)', () => {
  const live = {
    name: 's_db',
    image: 'mysql:8.4.7',
    env: { MYSQL_PASSWORD_FILE: '/run/secrets/s-pw', OTHER: '/run/secrets/unrelated' },
    secrets: [
      { source: 's-pw__v2', target: 's-pw' },
      { source: 's-pw__v2', target: 'PW' },
      { source: 'plain-secret' },
    ],
    secretEnv: ['PW'],
  } as ServiceSpec;

  it('carries family refs, their *_FILE env and env-delivered names from the live spec', () => {
    const out = carrySecretFamilies({ name: 's_db', image: 'mysql:8.4.7', env: { A: '1' } } as ServiceSpec, live);
    expect(out.secrets).toEqual([
      { source: 's-pw__v2', target: 's-pw' },
      { source: 's-pw__v2', target: 'PW' },
    ]);
    expect(out.env).toEqual({ A: '1', MYSQL_PASSWORD_FILE: '/run/secrets/s-pw' });
    expect(out.secretEnv).toEqual(['PW']);
  });

  it('the compose wins: a target or env key it sets itself is left alone', () => {
    const spec = {
      name: 's_db',
      image: 'mysql:8.4.7',
      env: { MYSQL_PASSWORD_FILE: '/run/secrets/mine', PW: 'literal' },
      secrets: [{ source: 'mine', target: 's-pw' }],
    } as ServiceSpec;
    const out = carrySecretFamilies(spec, live);
    expect(out.secrets).toEqual([{ source: 'mine', target: 's-pw' }, { source: 's-pw__v2', target: 'PW' }]);
    expect(out.env?.MYSQL_PASSWORD_FILE).toBe('/run/secrets/mine');
    expect(out.secretEnv).toBeUndefined();
  });

  it('no family on the live service ⇒ spec unchanged', () => {
    const spec = { name: 'x', image: 'y' } as ServiceSpec;
    expect(carrySecretFamilies(spec, { ...live, secrets: [{ source: 'plain' }] })).toBe(spec);
    expect(carrySecretFamilies(spec, undefined)).toBe(spec);
    expect(mountsSecretFamily(['plain', 'a__v1'])).toBe(true);
    expect(mountsSecretFamily(['plain'])).toBe(false);
  });
});

describe('carrySecretFamilies keeps managed-DB URL secrets on redeploy', () => {
  it('an app wired by db.inject keeps its env-delivered DATABASE_URL(+RO) secrets', () => {
    const live = {
      name: 'shop_web',
      image: 'web:1',
      env: { LOG: 'debug' },
      secrets: [
        { source: 'shop_main-pg-url__v2', target: 'DATABASE_URL' },
        { source: 'shop_main-pg-ro-url__v2', target: 'DATABASE_RO_URL' },
      ],
      secretEnv: ['DATABASE_RO_URL', 'DATABASE_URL'],
    } as ServiceSpec;
    expect(mountsSecretFamily(['shop_main-pg-url__v2'])).toBe(true);
    const out = carrySecretFamilies({ name: 'shop_web', image: 'web:2', env: { LOG: 'info' } } as ServiceSpec, live);
    expect(out.secrets).toEqual(live.secrets);
    expect(out.secretEnv).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    expect(out.env?.DATABASE_URL).toBeUndefined();
  });
});
