import { describe, expect, test } from 'bun:test';
import {
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
