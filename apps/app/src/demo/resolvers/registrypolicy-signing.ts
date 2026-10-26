import type { ImageSignatureView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { DEMO_SCANNED_DIGESTS } from './cicd-build-log';

/**
 * Demo resolvers for who signed what: the app canvas's sign chip
 * (`registryPolicy.signatures`) and the keys the workspace trusts
 * (`registryPolicy.addTrustedKey` / `removeTrustedKey`, stored on the
 * registry-policy demo state). Northwind's own builds are signed with the
 * workspace key, checkout ships a vendor SDK signed with a trusted key, the
 * worker was deployed unsigned, and Docker Hub / GHCR images are never checked.
 */

interface PolicyState {
  policy: { trustedKeys: { name: string; fingerprint: string }[]; updatedAt: string };
}

const HOUR = 3_600_000;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const hex = (seed: string): string => {
  let h = 0x811c9dc5;
  let out = '';
  while (out.length < 64) {
    for (const c of seed + out.length) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
};

/** Service → [repo, tag, verdict facts] for the parts swarmy built into the org registry. */
const OWN: Record<string, { repo: string; tag: string; sign: Partial<ImageSignatureView> }> = {
  web: { repo: 'northwind-web', tag: '1.8.2', sign: { state: 'swarmy', source: 'build', checkedAt: iso(2 * HOUR) } },
  api: { repo: 'northwind-api', tag: '2.4.0', sign: { state: 'swarmy', source: 'admission', checkedAt: iso(0.7 * HOUR) } },
  checkout: { repo: 'northwind-checkout', tag: '1.1.0', sign: { state: 'trusted', keyName: 'Acme payments SDK', source: 'admission', checkedAt: iso(3 * HOUR) } },
  worker: { repo: 'northwind-worker', tag: '2.4.0', sign: { state: 'unsigned', source: 'admission', checkedAt: iso(26 * HOUR) } },
};

function signatures(store: DemoStore, stack: string): ImageSignatureView[] {
  const stackId = store.stacks.find((s) => s.name === stack)?.id;
  return store.services
    .filter((sv) => sv.stackId === stackId)
    .map((sv): ImageSignatureView => {
      const own = OWN[sv.name];
      if (!own) return { service: sv.name, image: sv.image, digest: null, state: 'unchecked', why: 'third-party' };
      const digest = DEMO_SCANNED_DIGESTS[`${own.repo}:${own.tag}`] ?? `sha256:${hex(own.repo)}`;
      return { service: sv.name, image: `localhost:5000/${own.repo}:${own.tag}@${digest}`, digest, keyName: null, ...own.sign } as ImageSignatureView;
    });
}

function policy(store: DemoStore): PolicyState['policy'] {
  return (store.extra.registrypolicy as PolicyState).policy;
}

export const registrypolicySigning: DomainResolvers = {
  handlers: {
    'registryPolicy.signatures': (i, s) => signatures(s, (i as { stack: string }).stack),
    'registryPolicy.addTrustedKey': (i, s) => {
      const { name, publicKey } = i as { name: string; publicKey: string };
      const p = policy(s);
      if (p.trustedKeys.some((k) => k.name.toLowerCase() === name.trim().toLowerCase())) throw new Error(`A key named “${name}” is already trusted.`);
      p.trustedKeys = [...p.trustedKeys, { name: name.trim(), fingerprint: hex(publicKey).slice(0, 16) }];
      p.updatedAt = new Date().toISOString();
      return p;
    },
    'registryPolicy.removeTrustedKey': (i, s) => {
      const { name } = i as { name: string };
      const p = policy(s);
      p.trustedKeys = p.trustedKeys.filter((k) => k.name.toLowerCase() !== name.trim().toLowerCase());
      p.updatedAt = new Date().toISOString();
      return p;
    },
  },
};
