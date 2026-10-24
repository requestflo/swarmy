import { TRPCError } from '@trpc/server';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { stacks } from './apps.repo';
import { createGrant } from './members.service';

/**
 * The one app grant an app-scoped invite gives — an invite link or an email /
 * link invitation. The invitee joins as a member with an `operator` grant on
 * the app, through the same `createGrant` path Settings → Access uses (and
 * audited the same way), so the seeded "Resource operators can operate their
 * resources" rule lets them ship that app, production included.
 */

export type InviteRoleLike = 'owner' | 'admin' | 'member';

/** What the grant writer needs: the store, the hub (swarm config), who acted. */
export interface InviteGrantScope {
  db: DB;
  hub: AgentHub;
  user?: { id: string } | null;
}

/**
 * The app an invite may name. Owners and admins already reach every app, so an
 * app only narrows a member; a blank name means the whole org.
 */
export function inviteStackName(role: InviteRoleLike, stackName: string | null | undefined): string | null {
  const name = stackName?.trim() || null;
  if (name && role !== 'member') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `an ${role} covers every app — pick Member to limit the invite to one app`,
    });
  }
  return name;
}

/** The grant target for an app: its config-row id (what grants key on), else its name. */
export async function stackResourceId(scope: InviteGrantScope, orgId: string, stackName: string): Promise<string> {
  const row = await stacks(scope, orgId)
    .findFirst({ where: { name: stackName, orgId }, select: { id: true } })
    .catch(() => null);
  return row?.id ?? stackName;
}

/** Give a member `operator` on the app their invite named (idempotent: grants upsert). */
export async function grantInviteApp(
  scope: InviteGrantScope,
  orgId: string,
  memberId: string,
  stackName: string,
): Promise<void> {
  const ctx = { db: scope.db, hub: scope.hub, user: scope.user ?? null, activeOrgId: orgId, membership: { role: 'member', orgId } };
  await createGrant(ctx as unknown as OrgContext, {
    principalType: 'member',
    principalId: memberId,
    resourceType: 'stack',
    resourceId: await stackResourceId(scope, orgId, stackName),
    relation: 'operator',
  });
}
