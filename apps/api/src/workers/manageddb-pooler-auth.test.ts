import { describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { poolerPassword, scramKeys, scramVerifier } from './manageddb-pooler-auth';

/**
 * RFC 7677 §3's SCRAM-SHA-256 exchange (user "user", password "pencil"): the
 * keys swarmy derives must verify that client proof and produce that server
 * signature, or Postgres would reject the pooler's login.
 */
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const NONCE = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const AUTH_MESSAGE = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${NONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${NONCE}`;
const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

describe('the pooler login (SCRAM-SHA-256)', () => {
  it('derives the RFC 7677 keys', () => {
    const k = scramKeys('pencil', SALT, 4096);
    const sig = (key: Buffer) => createHmac('sha256', key).update(AUTH_MESSAGE).digest();
    expect(sig(k.serverKey).toString('base64')).toBe(SERVER_SIGNATURE);
    const proof = Buffer.from(CLIENT_PROOF, 'base64');
    const clientKey = Buffer.from(proof.map((b, i) => b ^ sig(k.storedKey)[i]!));
    expect(createHash('sha256').update(clientKey).digest().equals(k.storedKey)).toBe(true);
  });

  it('writes the verifier in the form Postgres stores, never the password', () => {
    const v = scramVerifier('pencil', SALT, 4096);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(v).not.toContain('pencil');
    expect(scramVerifier('pencil')).not.toBe(scramVerifier('pencil')); // a fresh salt each time
  });

  it('mints 32-character alphanumeric passwords', () => {
    const a = poolerPassword();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(poolerPassword()).not.toBe(a);
  });
});
