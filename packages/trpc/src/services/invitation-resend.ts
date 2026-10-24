import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import {
  findPendingOrThrow,
  inviteLinkBase,
  mailInvite,
  regenerateInvitation,
  toView,
  type InvitationView,
} from './invitations.service';

/**
 * Resend a pending invitation by email (the Pending invites row's Resend).
 * A live invite is mailed again with its SAME link; an expired one can't be
 * revived, so it is regenerated (new link, fresh 7 days, mailed). Mail goes
 * through swarmy's email service when it is on — `emailed: false` tells the
 * admin nothing was sent, so they carry the link instead.
 */
export async function resendInvitation(ctx: OrgContext, id: string, now: Date = new Date()): Promise<InvitationView> {
  const row = await findPendingOrThrow(ctx, id);
  if (row.expiresAt.getTime() <= now.getTime()) return regenerateInvitation(ctx, id);
  const view = toView(row, inviteLinkBase(ctx.reqHeaders), now);
  if (view.kind !== 'email') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This invite has no email address to send to. Copy its link instead.' });
  }
  const emailed = await mailInvite(ctx, view);
  await writeAudit(ctx, {
    action: 'member.invite.resend',
    targetType: 'invitation',
    targetId: id,
    metadata: { email: view.email, role: view.role, stackName: view.stackName, emailed },
  });
  return { ...view, emailed };
}
