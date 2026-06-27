import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptWithPassphrase } from '@swarmy/core/crypto';
import {
  deserializeBundle,
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
      dbDriver: 'pglite',
      createdAt: '2026-06-27T00:00:00.000Z',
      orgCount: 2,
      nodeCount: 5,
      includedTables: 'control-plane',
    },
    // a "mock dump" — exactly what dumpControlPlane would produce.
    dbDump: Buffer.from(
      "SET session_replication_role = replica;\nINSERT INTO organization (id) VALUES ('org_1');\n",
    ),
    secrets: {
      SWARMY_SECRET_KEY: 'super-secret-key-value',
      BETTER_AUTH_SECRET: 'auth-secret',
      config: { SWARMY_DB_DRIVER: 'pglite', CONTROLLER_PUBLIC_URL: 'https://ctl.example' },
    },
  };
}

describe('controller-state bundle serialize/deserialize', () => {
  test('round-trips manifest + dump + secrets exactly', () => {
    const original = fixture();
    const restored = deserializeBundle(serializeBundle(original));
    expect(restored.manifest).toEqual(original.manifest);
    expect(Buffer.from(restored.dbDump).equals(original.dbDump)).toBe(true);
    expect(restored.secrets).toEqual(original.secrets);
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
    expect(Buffer.from(restored.dbDump).toString()).toContain('INSERT INTO organization');
    expect(restored.manifest.dbDriver).toBe('pglite');
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
