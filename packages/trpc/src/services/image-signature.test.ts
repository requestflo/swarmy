import { describe, expect, it } from 'bun:test';
import { keyFingerprint, pinnedDigest, runningImage, signatureView, verifyOrder, type SignatureCheckRow } from './image-signature';

const D = `sha256:${'a'.repeat(64)}`;
const IMG = `localhost:5000/northwind-api:main@${D}`;
const AT = new Date('2026-10-26T09:00:00Z');
const row = (over: Partial<SignatureCheckRow> = {}): SignatureCheckRow => ({ digest: D, verdict: 'swarmy', keyName: null, source: 'admission', checkedAt: AT, ...over });
const part = (over: Partial<Parameters<typeof signatureView>[0]> = {}) =>
  signatureView({ service: 'storefront_api', image: IMG, digest: D, orgImage: true, newest: row(), ...over });

describe('pinnedDigest / runningImage', () => {
  it('reads the digest Docker pinned, and nothing else', () => {
    expect(pinnedDigest(IMG)).toBe(D);
    expect(pinnedDigest('localhost:5000/api:main')).toBeNull();
    expect(pinnedDigest('api@latest')).toBeNull();
  });
  it('prefers the service spec, then a running container, else no digest', () => {
    expect(runningImage({ image: IMG, containers: [] })).toEqual({ image: IMG, digest: D });
    const c = { id: 'c', name: 'api.1', image: IMG, state: 'running' as const };
    expect(runningImage({ image: 'localhost:5000/api:main', containers: [{ ...c, state: 'exited' }, c] })).toEqual({ image: IMG, digest: D });
    expect(runningImage({ image: 'postgres:16', containers: [] })).toEqual({ image: 'postgres:16', digest: null });
  });
});

describe('signatureView — unknown stays "not checked", never a guess', () => {
  it('another registry is never checked, even when pinned', () => {
    expect(part({ image: `postgres:16@${D}`, orgImage: false })).toMatchObject({ state: 'unchecked', why: 'third-party' });
  });
  it('an unpinned ref has nothing fixed to check', () => {
    expect(part({ digest: null, newest: null })).toMatchObject({ state: 'unchecked', why: 'not-pinned' });
  });
  it('no recorded answer, a row for another digest, or an unknown verdict → never-checked', () => {
    expect(part({ newest: null })).toMatchObject({ state: 'unchecked', why: 'never-checked' });
    expect(part({ newest: row({ digest: 'sha256:bbbbbb' }) })).toMatchObject({ state: 'unchecked', why: 'never-checked' });
    expect(part({ newest: row({ verdict: 'maybe' }) })).toMatchObject({ state: 'unchecked', why: 'never-checked' });
  });
  it('the newest verdict, with where it came from and when', () => {
    expect(part()).toEqual({ service: 'storefront_api', image: IMG, digest: D, state: 'swarmy', keyName: null, source: 'admission', checkedAt: AT.toISOString() });
    expect(part({ newest: row({ source: 'build' }) })).toMatchObject({ state: 'swarmy', source: 'build' });
    expect(part({ newest: row({ verdict: 'trusted', keyName: 'Acme release' }) })).toMatchObject({ state: 'trusted', keyName: 'Acme release' });
    expect(part({ newest: row({ verdict: 'unsigned', keyName: 'stale' }) })).toMatchObject({ state: 'unsigned', keyName: null });
  });
});

describe('verifyOrder', () => {
  it('the org key first, then trusted keys in the listed order', () => {
    const keys = verifyOrder({ cosignPublicKey: 'ORG', trustedKeys: [{ name: 'a', publicKey: 'A' }, { name: 'b', publicKey: 'B' }] });
    expect(keys.map((k) => [k.verdict, k.name, k.publicKey])).toEqual([
      ['swarmy', null, 'ORG'],
      ['trusted', 'a', 'A'],
      ['trusted', 'b', 'B'],
    ]);
  });
  it('no keys at all → nothing to verify with', () => {
    expect(verifyOrder(null)).toEqual([]);
    expect(verifyOrder({ cosignPublicKey: null })).toEqual([]);
  });
});

describe('keyFingerprint', () => {
  it('hashes the DER body, ignoring armour and whitespace', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nAAEC\nAwQ=\n-----END PUBLIC KEY-----\n';
    // sha256(00 01 02 03 04)
    expect(keyFingerprint(pem)).toBe('08bb5e5d6eaac104');
    expect(keyFingerprint(pem.replace(/\n/g, '\r\n'))).toBe(keyFingerprint(pem));
  });
});
