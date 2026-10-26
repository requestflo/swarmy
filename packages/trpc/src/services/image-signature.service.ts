/**
 * The per-digest signing record behind the app canvas's sign chip. Verdicts
 * are written where cosign actually answered: admission's verify at deploy
 * (`admission-images.evaluate`) and swarmy's build signing a digest
 * (`registryPolicy.onImageBuilt`). Reads join each part's LIVE running digest
 * (Docker truth) with the newest recorded verdict for it (control.db history).
 */
import { buildInventory, type ImageSignatureView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { registryConfigs, type RegistryConfigDoc } from './apps.repo';
import { canonicalRegistryHost, isOrgRegistryImage, verifyImageSignatureWith } from './registryPolicy.service';
import { runningImage, signatureView, verifyOrder, type SignVerdict } from './image-signature';

export interface SignCheck {
  verdict: SignVerdict;
  keyName: string | null;
}

type KeysDoc = Pick<RegistryConfigDoc, 'cosignPublicKey' | 'trustedKeys'> | null;

/**
 * cosign verify `ref` against the org key, then each trusted key; the first
 * key that verifies names the verdict. Null when there is no key to check
 * with (nothing was checked). Dispatch failures propagate: the caller fails
 * closed and records nothing.
 */
export async function checkImageSignature(ctx: OrgContext, ref: string, cfg?: KeysDoc): Promise<SignCheck | null> {
  const doc = cfg !== undefined ? cfg : await registryConfigs(ctx, ctx.activeOrgId).findUnique({ where: { orgId: ctx.activeOrgId } });
  const keys = verifyOrder(doc);
  if (keys.length === 0) return null;
  for (const k of keys) {
    if (await verifyImageSignatureWith(ctx, ref, k.publicKey)) return { verdict: k.verdict, keyName: k.name };
  }
  return { verdict: 'unsigned', keyName: null };
}

/** Each part of one app and the signature on the digest it runs right now. */
export async function stackSignatures(ctx: OrgContext, stack: string): Promise<ImageSignatureView[]> {
  const cfg = await registryConfigs(ctx, ctx.activeOrgId).findUnique({ where: { orgId: ctx.activeOrgId } });
  const host = canonicalRegistryHost(cfg?.host);
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const parts = buildInventory(services, containers)
    .services.filter((s) => s.stack === stack)
    .map((s) => ({ service: s.name, ...runningImage(s) }));
  const digests = [...new Set(parts.map((p) => p.digest).filter((d): d is string => !!d))];
  const newest = new Map(
    await Promise.all(
      digests.map(
        async (digest) =>
          [
            digest,
            await ctx.db.imageSignatureCheck.findFirst({
              where: { orgId: ctx.activeOrgId, digest },
              orderBy: { checkedAt: 'desc' },
              select: { digest: true, verdict: true, keyName: true, source: true, checkedAt: true },
            }),
          ] as const,
      ),
    ),
  );
  return parts.map((p) =>
    signatureView({
      ...p,
      orgImage: isOrgRegistryImage(p.image, host),
      newest: p.digest ? (newest.get(p.digest) ?? null) : null,
    }),
  );
}
