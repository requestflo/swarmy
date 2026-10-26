import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { addTrustedKey, removeTrustedKey, withTrustedKey } from './trusted-keys.service';

const pem = (body: string) => `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
const A = { name: 'Acme release', publicKey: `${pem('AAEC')}\n` };

describe('withTrustedKey', () => {
  it('appends, normalising the PEM', () => {
    expect(withTrustedKey([], { name: ' Acme release ', publicKey: pem('AAEC') })).toEqual([A]);
  });
  it('refuses a second key with the same name or the same key under another name', () => {
    expect(withTrustedKey([A], { name: 'acme RELEASE', publicKey: pem('AwQ=') })).toBe('A key named “acme RELEASE” is already trusted.');
    expect(withTrustedKey([A], { name: 'Other', publicKey: pem('AAEC') })).toBe('That key is already trusted as “Acme release”.');
  });
  it('caps the list', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `k${i}`, publicKey: pem(`AA${i}=`) }));
    expect(withTrustedKey(ten, { name: 'eleventh', publicKey: pem('BBBB') })).toBe('You can trust up to 10 keys.');
  });
});

describe('add / remove a trusted key — admin writes land in the registry document, audited', () => {
  it('round-trips through the policy view as name + fingerprint, never the PEM', async () => {
    const audits: { action: string; metadata: unknown }[] = [];
    const ctx = {
      activeOrgId: 'org_trust',
      user: { id: 'u1' },
      db: { auditLog: { create: async (q: { data: { action: string; metadata: unknown } }) => audits.push(q.data) } },
      hub: {},
    } as unknown as OrgContext;
    const added = await addTrustedKey(ctx, { name: 'Acme release', publicKey: pem('AAEC') });
    // sha256(00 01 02): the key's DER bytes, as `openssl pkey -pubin -outform der | sha256sum` hashes them.
    expect(added.trustedKeys).toEqual([{ name: 'Acme release', fingerprint: 'ae4b3280e56e2faf' }]);
    expect(JSON.stringify(added)).not.toContain('BEGIN PUBLIC KEY');
    await expect(addTrustedKey(ctx, { name: 'Acme release', publicKey: pem('AwQ=') })).rejects.toThrow('already trusted');
    const removed = await removeTrustedKey(ctx, 'acme release');
    expect(removed.trustedKeys).toEqual([]);
    await expect(removeTrustedKey(ctx, 'nope')).rejects.toThrow('not found');
    expect(audits.map((a) => a.action)).toEqual(['registryPolicy.trustKey', 'registryPolicy.untrustKey']);
  });
});
