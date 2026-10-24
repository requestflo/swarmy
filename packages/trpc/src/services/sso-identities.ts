import { TRPCError } from '@trpc/server';
import type { DB } from '@swarmy/db';

/**
 * An SSO provider id names the identities its IdP vouched for. Better Auth
 * signs a returning user in by their `account` row (providerId + the IdP's
 * subject) and checks nothing else, so whoever controls a provider id can
 * answer for every identity filed under it. Hence:
 *
 *  - deleting a provider deletes its `account` rows and retires the id to the
 *    org (`SsoProviderRetired`);
 *  - renaming one moves its rows to the new id and retires the old id;
 *  - an id can't be claimed if another org retired it, another provider holds
 *    it, or leftover rows under it belong to people outside this org (rows
 *    from before this rule, or from an org that was deleted).
 *
 * The owning org may re-create its own retired id.
 */

export type SsoIdentityDb = Pick<DB, 'account' | 'ssoProvider' | 'ssoProviderRetired'>;

function conflict(message: string): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message });
}

/** Refuse `providerId` for a new provider (or a rename) in `orgId`. */
export async function assertProviderIdClaimable(db: SsoIdentityDb, orgId: string, providerId: string): Promise<void> {
  const live = await db.ssoProvider.findUnique({ where: { providerId }, select: { id: true } });
  if (live) throw conflict(`an SSO provider with id "${providerId}" already exists — pick another id`);
  const retired = await db.ssoProviderRetired.findUnique({ where: { providerId }, select: { orgId: true } });
  if (retired && retired.orgId !== orgId) {
    throw conflict(`SSO provider id "${providerId}" was used by another workspace — pick another id`);
  }
  const stranger = await db.account.findFirst({
    where: { providerId, user: { members: { none: { organizationId: orgId } } } },
    select: { id: true },
  });
  if (stranger) {
    throw conflict(`sign-ins from an earlier "${providerId}" provider still exist — pick another id`);
  }
}

/**
 * Retire `providerId` to `orgId`, and delete the identities filed under it
 * (or move them to `moveTo` on a rename). Returns how many rows changed.
 */
export async function retireProviderId(
  db: SsoIdentityDb,
  orgId: string,
  providerId: string,
  opts: { moveTo?: string } = {},
): Promise<number> {
  await db.ssoProviderRetired.upsert({ where: { providerId }, create: { providerId, orgId }, update: {} });
  const res = opts.moveTo
    ? await db.account.updateMany({ where: { providerId }, data: { providerId: opts.moveTo } })
    : await db.account.deleteMany({ where: { providerId } });
  return res.count;
}
