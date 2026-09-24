import { describe, expect, it } from 'bun:test';
import {
  canonicalizeBody,
  canonicalizeHeader,
  dkimPublicKeyOf,
  dkimRecordValue,
  dkimSign,
  dkimVerify,
  generateDkimKey,
  parseTags,
} from './dkim';
import { MADDY_PUBLIC_KEY, MADDY_SIGNED, MADDY_SIGNED_AT } from './fixtures.test-data';

const key = generateDkimKey();
const MSG = 'From: App <noreply@example.com>\nTo: someone@example.org\nSubject:  Hello   there \nDate: Thu, 24 Sep 2026 18:00:00 +0000\nMessage-ID: <1@example.com>\n\nHi there,  \n\nbody line\n\n\n';

describe('DKIM canonicalization (RFC 6376 §3.4)', () => {
  it('relaxed header: lowercase name, unfold, collapse whitespace', () => {
    expect(canonicalizeHeader('Subject:  Hello \r\n\t  world  ', 'relaxed')).toBe('subject:Hello world');
  });
  it('relaxed body: trailing whitespace and empty trailing lines go; one CRLF ends it', () => {
    expect(canonicalizeBody('a  b \r\n\r\n\r\n', 'relaxed')).toBe('a b\r\n');
    expect(canonicalizeBody('', 'relaxed')).toBe('');
    expect(canonicalizeBody('', 'simple')).toBe('\r\n');
  });
});

describe('dkimSign / dkimVerify', () => {
  it('a signed message verifies against its key', async () => {
    const signed = dkimSign(MSG, { domain: 'example.com', privateKeyPem: key.privateKeyPem, timestamp: 1_790_000_000 });
    const tags = parseTags(signed.split('\r\n')[0]!.slice('DKIM-Signature:'.length));
    expect(tags.d).toBe('example.com');
    expect(tags.s).toBe('swarmy');
    expect(tags.h).toBe('from:to:subject:date:message-id');
    expect(await dkimVerify(signed, { publicKeyB64: key.publicKeyB64 })).toEqual({ status: 'pass', domain: 'example.com', selector: 'swarmy' });
  });

  it('whitespace changes survive relaxed canonicalization', async () => {
    const signed = dkimSign(MSG, { domain: 'example.com', privateKeyPem: key.privateKeyPem });
    const reflowed = signed.replace('Subject:  Hello   there ', 'Subject: Hello there').replace('body line', 'body   line');
    expect((await dkimVerify(reflowed, { publicKeyB64: key.publicKeyB64 })).status).toBe('pass');
  });

  it('a changed body or header fails', async () => {
    const signed = dkimSign(MSG, { domain: 'example.com', privateKeyPem: key.privateKeyPem });
    expect(await dkimVerify(signed.replace('body line', 'evil line'), { publicKeyB64: key.publicKeyB64 })).toMatchObject({ status: 'fail', reason: 'body hash mismatch' });
    expect(await dkimVerify(signed.replace('Subject:  Hello', 'Subject:  Pay'), { publicKeyB64: key.publicKeyB64 })).toMatchObject({ status: 'fail', reason: 'signature does not verify' });
  });

  it('a different key fails; no signature is none', async () => {
    const signed = dkimSign(MSG, { domain: 'example.com', privateKeyPem: key.privateKeyPem });
    expect((await dkimVerify(signed, { publicKeyB64: generateDkimKey().publicKeyB64 })).status).toBe('fail');
    expect((await dkimVerify(MSG, { publicKeyB64: key.publicKeyB64 })).status).toBe('none');
  });

  it('looks the key up in DNS at <selector>._domainkey.<domain>', async () => {
    const signed = dkimSign(MSG, { domain: 'example.com', privateKeyPem: key.privateKeyPem });
    const asked: string[] = [];
    const lookup = async (name: string) => {
      asked.push(name);
      // DNS returns long records split into strings; the lookup joins them.
      return [dkimRecordValue(key.publicKeyB64)];
    };
    expect((await dkimVerify(signed, { lookup })).status).toBe('pass');
    expect(asked).toEqual(['swarmy._domainkey.example.com']);
    expect((await dkimVerify(signed, { lookup: async () => [] })).status).toBe('permerror');
    expect((await dkimVerify(signed, { lookup: async () => ['v=DKIM1; p='] })).reason).toBe('key revoked');
  });

  it('the public key round-trips from the stored private key', () => {
    expect(dkimPublicKeyOf(key.privateKeyPem)).toBe(key.publicKeyB64);
    expect(dkimRecordValue(key.publicKeyB64)).toBe(`v=DKIM1; k=rsa; p=${key.publicKeyB64}`);
  });
});

describe('cross-implementation: maddy-signed mail', () => {
  it('verifies the signature maddy produced (oversigned h=, folded b=)', async () => {
    const now = Number(MADDY_SIGNED_AT) + 60;
    expect(await dkimVerify(MADDY_SIGNED, { publicKeyB64: MADDY_PUBLIC_KEY }, { now })).toEqual({
      status: 'pass',
      domain: 'example.test',
      selector: 'swarmy',
    });
  });
  it('honours x= (expiry)', async () => {
    const r = await dkimVerify(MADDY_SIGNED, { publicKeyB64: MADDY_PUBLIC_KEY }, { now: Number(MADDY_SIGNED_AT) + 30 * 86400 });
    expect(r).toMatchObject({ status: 'fail', reason: 'signature expired' });
  });
});
