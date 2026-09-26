import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptWithPassphrase } from '@swarmy/core/crypto';
import {
  defaultRunner,
  deserializeBundle,
  resticMissingMessage,
  runRestic,
  serializeBundle,
  type BundleContents,
} from './controllerBackup.bundle';

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function fixture(): BundleContents {
  return {
    manifest: {
      swarmyVersion: '1.2.3',
      schemaVersion: '1',
      dbDriver: 'sqlite',
      createdAt: '2026-06-27T00:00:00.000Z',
      orgCount: 2,
      nodeCount: 5,
      includedTables: 'control-plane',
    },
    // stands in for a VACUUM INTO snapshot: the SQLite header + payload bytes.
    dbSnapshot: Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from('org_1 payload')]),
    secrets: {
      SWARMY_SECRET_KEY: 'super-secret-key-value',
      BETTER_AUTH_SECRET: 'auth-secret',
      config: { CONTROLLER_PUBLIC_URL: 'https://ctl.example' },
    },
  };
}

describe('controller-state bundle serialize/deserialize', () => {
  test('round-trips manifest + snapshot + secrets exactly', () => {
    const original = fixture();
    const restored = deserializeBundle(serializeBundle(original));
    expect(restored.manifest).toEqual(original.manifest);
    expect(Buffer.from(restored.dbSnapshot).equals(original.dbSnapshot)).toBe(true);
    expect(restored.secrets).toEqual(original.secrets);
  });

  test('refuses a Postgres-era bundle (db.sql, no control.db)', () => {
    const frame = (name: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(name.length, 0);
      h.writeUInt32BE(data.length, 4);
      return Buffer.concat([h, Buffer.from(name), data]);
    };
    const blob = Buffer.concat([
      Buffer.from('SWCBSTORE1'),
      frame('manifest.json', Buffer.from('{}')),
      frame('db.sql', Buffer.from('INSERT …')),
      frame('secrets.json', Buffer.from('{}')),
    ]);
    expect(() => deserializeBundle(blob)).toThrow(/Postgres-era/);
  });

  test('rejects a corrupt store frame', () => {
    expect(() => deserializeBundle(Buffer.from('not a bundle'))).toThrow(/bad store magic/);
  });
});

describe('bundle build → store(temp dir) → restore round-trip (restic mocked)', () => {
  test('encrypt to a temp dir, read back, decrypt, deserialize', async () => {
    // This mirrors createAndStoreBundle/restoreBundle without invoking restic:
    // the encrypted artefact restic would store is written to a temp dir, then
    // read back and decrypted exactly as restoreBundle does.
    const dir = await mkdtemp(join(tmpdir(), 'swarmy-cb-rt-'));
    tmpDirs.push(dir);
    const passphrase = 'a-strong-restore-passphrase';
    const contents = fixture();

    const encrypted = encryptWithPassphrase(serializeBundle(contents), passphrase);
    const bundlePath = join(dir, 'bundle.swcb');
    await writeFile(bundlePath, encrypted);

    // … restic restore would land the same bytes; read them back.
    const onDisk = await readFile(bundlePath);
    expect(onDisk.equals(encrypted)).toBe(true);

    const { decryptWithPassphrase } = await import('@swarmy/core/crypto');
    const restored = deserializeBundle(decryptWithPassphrase(onDisk, passphrase));

    expect(restored.secrets.SWARMY_SECRET_KEY).toBe(contents.secrets.SWARMY_SECRET_KEY);
    expect(Buffer.from(restored.dbSnapshot).toString('latin1')).toContain('org_1 payload');
    expect(restored.manifest.dbDriver).toBe('sqlite');
  });

  test('wrong passphrase cannot restore the temp-dir artefact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarmy-cb-rt2-'));
    tmpDirs.push(dir);
    const encrypted = encryptWithPassphrase(serializeBundle(fixture()), 'the-correct-pass');
    const path = join(dir, 'bundle.swcb');
    await writeFile(path, encrypted);
    const { decryptWithPassphrase } = await import('@swarmy/core/crypto');
    expect(() => decryptWithPassphrase(encrypted, 'the-wrong-pass!')).toThrow();
  });
});

describe('runRestic — missing restic executable', () => {
  const repo = { kind: 'node' as const, repo: '/tmp/swarmy-nonexistent-repo', password: 'x' };

  test('binary mode on $PATH: actionable install hint instead of raw ENOENT', async () => {
    const err = await runRestic(['version'], repo, {
      mode: 'binary',
      resticPath: 'swarmy-definitely-not-a-restic-binary',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('restic is not available on the controller');
    expect(err!.message).toContain('brew install restic');
    expect(err!.message).toContain('SWARMY_RESTIC_BINARY');
  }, 30_000);

  test('defaultRunner is binary mode unless explicitly set to docker', () => {
    expect(defaultRunner({}).mode).toBe('binary');
    expect(defaultRunner({ SWARMY_CONTROLLER_RESTIC_MODE: 'docker' }).mode).toBe('docker');
  });

  test('docker mode message names the docker CLI, not restic install', () => {
    expect(resticMissingMessage({ mode: 'docker' })).toContain('`docker` CLI');
  });
});
