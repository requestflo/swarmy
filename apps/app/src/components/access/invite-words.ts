import { untilWords } from '@/components/apikeys/key-words';

export type InviteRole = 'member' | 'admin';
export type InviteExpiry = '1d' | '7d' | 'never';
export type InviteUses = '1' | '10' | 'unlimited';
export type InviteState = 'ok' | 'expired' | 'used' | 'revoked';

export const INVITE_EXPIRY_LABEL: Record<InviteExpiry, string> = { '1d': '1 d', '7d': '7 d', never: 'never' };
export const INVITE_USES_MAX: Record<InviteUses, number | null> = { '1': 1, '10': 10, unlimited: null };
export const INVITE_STATE_WORD: Record<InviteState, string> = { ok: 'Active', expired: 'Expired', used: 'Used up', revoked: 'Revoked' };

const EXPIRY_SAY: Record<InviteExpiry, string> = { '1d': 'for a day', '7d': 'for 7 days', never: 'until you revoke it' };

/** The live sentence: "Whoever opens this link joins as a member on storefront, up to 10 people, for 7 days." */
export function describeInviteLink(o: { role: InviteRole; stackName: string | null; expiry: InviteExpiry; maxUses: number | null }): string {
  const where = o.role === 'admin' ? ' on every app' : o.stackName ? ` on ${o.stackName}` : '';
  const who = o.maxUses === null ? 'any number of people' : o.maxUses === 1 ? 'one person only' : `up to ${o.maxUses} people`;
  return `Whoever opens this link joins as ${o.role === 'admin' ? 'an admin' : 'a member'}${where}, ${who}, ${EXPIRY_SAY[o.expiry]}.`;
}

/** "used 3 of 10" · "used 2" (unlimited). */
export function usesWords(uses: number, maxUses: number | null): string {
  return maxUses === null ? `used ${uses}` : `used ${uses} of ${maxUses}`;
}

/** "expires in 5 days" · "never expires" · "expired". */
export function inviteEndsWords(state: InviteState, expiresAt: string | null, now = Date.now()): string {
  if (state === 'expired') return 'expired';
  if (!expiresAt) return 'never expires';
  return `expires ${untilWords(expiresAt, now)}`;
}
