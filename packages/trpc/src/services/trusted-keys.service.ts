/**
 * Keys the org trusts besides its own: a vendor's or another team's cosign
 * public key whose signatures count as signed, at admission and on the app
 * canvas's sign chip. Registry policy config, so it lives in the registry
 * swarm-kv document beside the org key. Public keys only; never a private key.
 */
import { MAX_TRUSTED_KEYS, type RegistryPolicyView, type TrustedKeyInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, notFound } from '../errors';
import { registryConfigs } from './apps.repo';
import { writeAudit } from './audit.service';
import { clearVerifyCache } from './admission-images';
import { keyFingerprint } from './image-signature';
import { getPolicy } from './registryPolicy.service';

type Key = { name: string; publicKey: string };

/** Pure: the list with one more key, or why not. */
export function withTrustedKey(keys: readonly Key[], add: Key): Key[] | string {
  const name = add.name.trim();
  const publicKey = `${add.publicKey.trim()}\n`;
  if (keys.length >= MAX_TRUSTED_KEYS) return `You can trust up to ${MAX_TRUSTED_KEYS} keys.`;
  if (keys.some((k) => k.name.toLowerCase() === name.toLowerCase())) return `A key named “${name}” is already trusted.`;
  const fp = keyFingerprint(publicKey);
  const same = keys.find((k) => keyFingerprint(k.publicKey) === fp);
  if (same) return `That key is already trusted as “${same.name}”.`;
  return [...keys, { name, publicKey }];
}

async function save(ctx: OrgContext, keys: Key[], action: string, key: Key): Promise<RegistryPolicyView> {
  await registryConfigs(ctx, ctx.activeOrgId).update({ where: { orgId: ctx.activeOrgId }, data: { trustedKeys: keys } });
  clearVerifyCache(); // the next deploy re-checks against the new list
  await writeAudit(ctx, {
    action,
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    metadata: { name: key.name, fingerprint: keyFingerprint(key.publicKey) },
  });
  return getPolicy(ctx);
}

async function current(ctx: OrgContext): Promise<Key[]> {
  await getPolicy(ctx); // ensures the singleton exists
  const doc = await registryConfigs(ctx, ctx.activeOrgId).findUnique({ where: { orgId: ctx.activeOrgId } });
  return doc?.trustedKeys ?? [];
}

/** Trust one more public key (admin, audited). */
export async function addTrustedKey(ctx: OrgContext, input: TrustedKeyInput): Promise<RegistryPolicyView> {
  const next = withTrustedKey(await current(ctx), input);
  if (typeof next === 'string') throw badRequest(next);
  return save(ctx, next, 'registryPolicy.trustKey', next.at(-1)!);
}

/** Stop trusting a key, by name (admin, audited). */
export async function removeTrustedKey(ctx: OrgContext, name: string): Promise<RegistryPolicyView> {
  const keys = await current(ctx);
  const gone = keys.find((k) => k.name.toLowerCase() === name.trim().toLowerCase());
  if (!gone) throw notFound('trusted key', name);
  return save(ctx, keys.filter((k) => k !== gone), 'registryPolicy.untrustKey', gone);
}
