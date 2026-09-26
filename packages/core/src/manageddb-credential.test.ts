import { describe, expect, it } from 'bun:test';
import {
  DB_PASSWORD_SECRET_LABEL,
  PG_ENV,
  applyPgCredential,
  dbPasswordPath,
  dbSecretFamily,
  dbSecretName,
  isDbPasswordSecret,
  parseDbSecretName,
  pgNeedsCredentialMigration,
  pgPrimaryEnv,
  pgReplicaEnv,
} from './manageddb-pg';
import { applyPgMember, dbStorageLabels } from './manageddb-storage';

/**
 * Security: a managed Postgres member's password is a Docker secret
 * (`<family>__v<n>`), mounted as a file. No member spec carries it as env.
 */

const SECRET_VALUE = 'plaintext-db-password-xyz';

describe('managed-DB secret names', () => {
  it('follow the <family>__v<n> pattern and stay under Docker\'s 64-char cap', () => {
    expect(dbSecretName('shop', 'main', 'password', 3)).toBe('shop_main-pg-password__v3');
    expect(parseDbSecretName('shop_main-pg-password__v3')).toEqual({ family: 'shop_main-pg-password', version: 3 });
    const long = dbSecretName('s'.repeat(63), 'c'.repeat(40), 'ro-url', 12345);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith('-pg-ro-url__v12345')).toBe(true);
    expect(dbSecretFamily('s'.repeat(63), 'c'.repeat(40), 'password')).not.toBe(dbSecretFamily('s'.repeat(63), 'c'.repeat(39), 'password'));
  });

  it('recognises a password secret and its stable mount path', () => {
    expect(isDbPasswordSecret('shop_main-pg-password__v1')).toBe(true);
    expect(isDbPasswordSecret('shop_main-pg-url__v1')).toBe(false);
    expect(dbPasswordPath('shop_main-pg-password__v7')).toBe('/run/secrets/shop_main-pg-password');
  });
});

describe('applyPgCredential / applyPgMember', () => {
  const secret = dbSecretName('shop', 'main', 'password', 2);
  const legacy = {
    name: 'shop_main-primary',
    env: pgPrimaryEnv({ password: SECRET_VALUE, database: 'app', replicationUser: 'repl', replicationPassword: SECRET_VALUE }),
    labels: { 'swarmy.db.cluster': 'main' },
    secrets: [{ source: dbSecretName('shop', 'main', 'password', 1), target: 'shop_main-pg-password' }, { source: 'other' }],
  };

  it('moves the password to a mounted secret file and strips every plaintext copy', () => {
    const labels = { ...legacy.labels, [DB_PASSWORD_SECRET_LABEL]: secret, ...dbStorageLabels({ dataVolume: 'v' }) };
    const out = applyPgMember({ ...legacy, labels }, labels);
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
    expect(out.env![PG_ENV.passwordFile]).toBe('/run/secrets/shop_main-pg-password');
    expect(out.env![PG_ENV.replicationPasswordFile]).toBe('/run/secrets/shop_main-pg-password');
    // Exactly one version of the family is mounted, at the stable family path.
    expect(out.secrets).toEqual([{ source: 'other' }, { source: secret, target: 'shop_main-pg-password' }]);
    expect(out.labels[DB_PASSWORD_SECRET_LABEL]).toBe(secret);
  });

  it('a rebuild that lost the label still finds the mounted password secret (names-only refs)', () => {
    const rebuilt: { env: Record<string, string>; secrets: Array<{ source: string; target?: string }> } = { env: { [PG_ENV.passwordFile]: '/run/secrets/shop_main-pg-password' }, secrets: [{ source: secret }] };
    expect(applyPgCredential(rebuilt).secrets).toEqual([{ source: secret, target: 'shop_main-pg-password' }]);
  });

  it('a legacy member (no secret yet) is left for the reconcile migration', () => {
    const plain = { env: pgReplicaEnv({ password: SECRET_VALUE, replicationUser: 'repl', replicationPassword: SECRET_VALUE, primaryHost: 'p', primaryPort: 5432 }) };
    expect(applyPgCredential(plain)).toBe(plain);
    expect(pgNeedsCredentialMigration(plain.env, {})).toBe(true);
    expect(pgNeedsCredentialMigration({}, { [DB_PASSWORD_SECRET_LABEL]: secret })).toBe(false);
  });

  it('env builders omit the password entirely when a member is secret-backed', () => {
    const env = pgReplicaEnv({ replicationUser: 'repl', primaryHost: 'p', primaryPort: 5432 });
    expect(env[PG_ENV.password]).toBeUndefined();
    expect(env[PG_ENV.replicationPassword]).toBeUndefined();
  });
});
