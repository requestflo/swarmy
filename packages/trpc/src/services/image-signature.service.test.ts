import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { checkImageSignature, stackSignatures } from './image-signature.service';

const ORG = 'org_sign';
const D = `sha256:${'c'.repeat(64)}`;
const REF = `localhost:5000/northwind-api@${D}`;

/** A hub whose cosign verify passes only for `goodKey` (or throws when it's 'offline'). */
function ctxWith(goodKey: string | 'offline', db: Record<string, unknown> = {}, services: unknown[] = []): { ctx: OrgContext; keysTried: string[] } {
  const keysTried: string[] = [];
  const ctx = {
    activeOrgId: ORG,
    user: { id: 'u1' },
    db: { node: { findMany: async () => [{ id: 'n1' }] }, ...db },
    hub: {
      nodeInfoFor: () => ({ labels: {} }),
      isOnline: () => true,
      liveInventory: () => ({ services, containers: [] }),
      dispatch: async (_n: string, _cmd: string, p: { env: { COSIGN_PUBLIC_KEY: string } }) => {
        if (goodKey === 'offline') throw new Error('node offline');
        keysTried.push(p.env.COSIGN_PUBLIC_KEY);
        return { exitCode: p.env.COSIGN_PUBLIC_KEY === goodKey ? 0 : 1, output: '', durationMs: 1, timedOut: false };
      },
    },
  } as unknown as OrgContext;
  return { ctx, keysTried };
}

const CFG = { cosignPublicKey: 'ORG', trustedKeys: [{ name: 'Acme release', publicKey: 'ACME' }] };

describe('checkImageSignature — first key that verifies names the verdict', () => {
  it('the org key → swarmy, without trying the trusted ones', async () => {
    const { ctx, keysTried } = ctxWith('ORG');
    expect(await checkImageSignature(ctx, REF, CFG)).toEqual({ verdict: 'swarmy', keyName: null });
    expect(keysTried).toEqual(['ORG']);
  });
  it('a trusted key → trusted, with its name', async () => {
    const { ctx, keysTried } = ctxWith('ACME');
    expect(await checkImageSignature(ctx, REF, CFG)).toEqual({ verdict: 'trusted', keyName: 'Acme release' });
    expect(keysTried).toEqual(['ORG', 'ACME']);
  });
  it('no key verifies → unsigned', async () => {
    const { ctx } = ctxWith('OTHER');
    expect(await checkImageSignature(ctx, REF, CFG)).toEqual({ verdict: 'unsigned', keyName: null });
  });
  it('no key to check with → null (nothing was checked)', async () => {
    const { ctx, keysTried } = ctxWith('ORG');
    expect(await checkImageSignature(ctx, REF, { cosignPublicKey: null })).toBeNull();
    expect(keysTried).toEqual([]);
  });
  it('a dispatch failure propagates (admission fails closed, records nothing)', async () => {
    const { ctx } = ctxWith('offline');
    await expect(checkImageSignature(ctx, REF, CFG)).rejects.toThrow('node offline');
  });
});

describe('stackSignatures — live digests joined with the newest recorded verdict', () => {
  it('one view per part of the app; unknown stays not checked', async () => {
    const svc = (id: string, name: string, image: string, stack = 'storefront') => ({
      id, name, image, mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, labels: { 'com.docker.stack.namespace': stack },
    });
    const at = new Date('2026-10-26T08:00:00Z');
    const asked: unknown[] = [];
    const { ctx } = ctxWith('ORG', {
      imageSignatureCheck: {
        findFirst: async (q: { where: { orgId: string; digest: string } }) => {
          asked.push(q.where);
          return q.where.digest === D ? { digest: D, verdict: 'trusted', keyName: 'Acme release', source: 'admission', checkedAt: at } : null;
        },
      },
    }, [
      svc('s1', 'storefront_api', `localhost:5000/northwind-api:main@${D}`),
      svc('s2', 'storefront_db', `postgres:16@sha256:${'d'.repeat(64)}`),
      svc('s3', 'storefront_web', 'localhost:5000/northwind-web:main'),
      svc('s4', 'other_api', `localhost:5000/northwind-api:main@${D}`, 'other'),
    ]);
    const out = await stackSignatures(ctx, 'storefront');
    expect(out.map((v) => [v.service, v.state, v.why ?? v.keyName])).toEqual([
      ['storefront_api', 'trusted', 'Acme release'],
      ['storefront_db', 'unchecked', 'third-party'],
      ['storefront_web', 'unchecked', 'not-pinned'],
    ]);
    // Org-scoped, one lookup per distinct digest.
    expect(asked.every((w) => (w as { orgId: string }).orgId === ORG)).toBe(true);
  });
});
