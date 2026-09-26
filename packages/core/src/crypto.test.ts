import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearVaultKeyCache,
  decryptSecret,
  encryptSecret,
  vaultKeyCacheStats,
  decryptWithPassphrase,
  encryptWithPassphrase,
  generateRestorePassphrase,
  passphraseFingerprint,
} from './crypto';

describe('controller-state passphrase bundle', () => {
  test('round-trips arbitrary bytes', () => {
    const pass = 'correct horse battery staple';
    const plain = Buffer.from('a logical SQL dump + secrets + manifest', 'utf8');
    const frame = encryptWithPassphrase(plain, pass);
    // ciphertext frame must not contain the plaintext
    expect(frame.includes(plain)).toBe(false);
    const out = decryptWithPassphrase(frame, pass);
    expect(out.equals(plain)).toBe(true);
  });

  test('round-trips binary (non-utf8) payloads', () => {
    const pass = 'a-very-strong-passphrase';
    const plain = Buffer.from([0, 1, 2, 255, 254, 128, 7, 0, 0, 9]);
    const out = decryptWithPassphrase(encryptWithPassphrase(plain, pass), pass);
    expect(out.equals(plain)).toBe(true);
  });

  test('wrong passphrase fails to decrypt (authenticated)', () => {
    const frame = encryptWithPassphrase(Buffer.from('secret'), 'the-right-one');
    expect(() => decryptWithPassphrase(frame, 'the-wrong-one!')).toThrow(/wrong restore passphrase|decryption failed/);
  });

  test('rejects a non-bundle frame', () => {
    expect(() => decryptWithPassphrase(Buffer.from('garbage'), 'whatever-pass')).toThrow(/bad magic/);
  });

  test('uses a fresh salt+iv each time (distinct ciphertexts)', () => {
    const a = encryptWithPassphrase(Buffer.from('x'), 'same-passphrase');
    const b = encryptWithPassphrase(Buffer.from('x'), 'same-passphrase');
    expect(a.equals(b)).toBe(false);
  });

  test('rejects too-short passphrases', () => {
    expect(() => encryptWithPassphrase(Buffer.from('x'), 'short')).toThrow(/at least 8/);
  });

  test('generated passphrase is strong and round-trips', () => {
    const p = generateRestorePassphrase();
    expect(p).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    const out = decryptWithPassphrase(encryptWithPassphrase(Buffer.from('hi'), p), p);
    expect(out.toString()).toBe('hi');
  });

  test('fingerprint is stable and non-reversible-looking', () => {
    const p = 'fingerprint-me-please';
    expect(passphraseFingerprint(p)).toBe(passphraseFingerprint(p));
    expect(passphraseFingerprint(p)).not.toContain(p);
    expect(passphraseFingerprint(p)).toHaveLength(12);
  });
});

describe('vault key derivation cache', () => {
  const saved = process.env.SWARMY_SECRET_KEY;
  beforeEach(() => clearVaultKeyCache());
  afterEach(() => {
    if (saved === undefined) delete process.env.SWARMY_SECRET_KEY;
    else process.env.SWARMY_SECRET_KEY = saved;
    clearVaultKeyCache();
  });

  test('the same secret derives once, then hits the cache', () => {
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-a';
    const blob = encryptSecret('one');
    expect(decryptSecret(blob)).toBe('one');
    encryptSecret('two');
    expect(vaultKeyCacheStats()).toEqual({ size: 1, hits: 2, misses: 1 });
  });

  test('a different secret derives a different key (its own cache entry)', () => {
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-a';
    const blob = encryptSecret('only for a');
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-b';
    expect(() => decryptSecret(blob)).toThrow();
    expect(vaultKeyCacheStats()).toMatchObject({ size: 2, misses: 2 });
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-a';
    expect(decryptSecret(blob)).toBe('only for a');
    expect(vaultKeyCacheStats()).toMatchObject({ size: 2, misses: 2, hits: 1 });
  });

  test('is bounded: at most 8 keys, least recently used evicted first', () => {
    for (let i = 0; i < 8; i++) {
      process.env.SWARMY_SECRET_KEY = `cache-test-secret-${i}`;
      encryptSecret('x');
    }
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-0'; // touch 0: now 1 is the LRU
    encryptSecret('x');
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-8';
    encryptSecret('x');
    expect(vaultKeyCacheStats()).toEqual({ size: 8, hits: 1, misses: 9 });
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-0';
    encryptSecret('x');
    expect(vaultKeyCacheStats().misses).toBe(9); // 0 survived
    process.env.SWARMY_SECRET_KEY = 'cache-test-secret-1';
    encryptSecret('x');
    expect(vaultKeyCacheStats().misses).toBe(10); // 1 was evicted
  });

  test('ciphertext written before the cache still decrypts, and round-trips hold', () => {
    process.env.SWARMY_SECRET_KEY = 'fixture-vault-key-do-not-use';
    // Produced by encryptSecret before the key cache existed (uncached scrypt).
    const legacy = 'v1.sl6Hm1HSFZKjQHmD.3oic3AJxEvvTPqSAta_9JA._OGgosRjRVsV8YNW1GkeGR36YZu7UEddKOWOBilUnw';
    expect(decryptSecret(legacy)).toBe('hello from before the key cache');
    expect(decryptSecret(legacy)).toBe('hello from before the key cache'); // now from the cache
    expect(decryptSecret(encryptSecret('fresh ✓'))).toBe('fresh ✓');
    expect(vaultKeyCacheStats()).toEqual({ size: 1, hits: 3, misses: 1 });
  });
});
