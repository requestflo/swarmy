import type { DB } from '@swarmy/db';

/**
 * Who may change INSTANCE-WIDE configuration (rows with `orgId = null`, e.g.
 * the social sign-in providers, magic link and passkeys): the owner of the
 * controller's organization. One org per controller (auth-abac skill): that
 * org is the OLDEST one — the same org social `allowedDomains` sign-ups join
 * and the OIDC provider's claims come from. An admin, or the owner of any
 * later org (with open registration, anyone can create one), is refused —
 * otherwise they could swap a provider's client id/secret, point GitLab at
 * their own IdP, or open `allowedDomains` into the controller's org.
 */
export const INSTANCE_OWNER_REQUIRED = 'Only the owner of this swarmy’s organization can change instance-wide sign-in settings';

type InstanceOwnerDb = Pick<DB, 'organization' | 'member'>;

/** The controller's organization (the oldest), or null on a fresh install. */
export async function instanceOrgId(db: InstanceOwnerDb): Promise<string | null> {
  const org = await db.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  return org?.id ?? null;
}

/** Is `userId` an owner of the controller's organization? */
export async function isInstanceOwner(db: InstanceOwnerDb, userId: string): Promise<boolean> {
  const orgId = await instanceOrgId(db);
  if (!orgId) return false;
  const member = await db.member.findFirst({
    where: { organizationId: orgId, userId, role: 'owner' },
    select: { id: true },
  });
  return member !== null;
}
