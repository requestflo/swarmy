import { simulateInvite, type InviteApp, type InviteVerdict, type Role } from '@swarmy/abac';
import { SYSTEM_STACK } from '@swarmy/core';
import type { OrgContext } from '../context';
import { liveStackLabels, loadPolicyInputs } from '../abac';
import { listStacks } from './stack.service';

/**
 * `policies.simulateInvite`: what someone you are about to invite could do,
 * decided by the org's real rules over its real apps (live labels, so a
 * production app reads as production). Read-only and unaudited — it decides
 * nothing. The invitee is hypothetical: a role plus `operator` on each app the
 * invite names (the grant an accepted app-scoped invite really writes).
 */

export interface SimulateInviteArgs {
  role: Role;
  /** Apps the invite names. Owners and admins already cover every app. */
  stackNames?: string[];
}

export interface SimulateInviteResult {
  role: Role;
  /** The apps the preview granted (empty for owners and admins). */
  stackNames: string[];
  /** How many of the org's apps it was judged against. */
  appCount: number;
  verdicts: InviteVerdict[];
}

/** The org's apps (not the platform's own stack) as grant ids + live labels. */
export async function inviteApps(ctx: OrgContext): Promise<InviteApp[]> {
  const rows = await listStacks(ctx);
  return rows
    .filter((s) => s.name !== SYSTEM_STACK)
    .map((s) => ({ id: s.id, name: s.name, labels: liveStackLabels(ctx, s.name) ?? {} }));
}

export async function simulateInvitePolicy(ctx: OrgContext, args: SimulateInviteArgs): Promise<SimulateInviteResult> {
  const names = args.role === 'member' ? [...new Set((args.stackNames ?? []).map((n) => n.trim()).filter(Boolean))] : [];
  const [policies, apps] = await Promise.all([loadPolicyInputs(ctx.db, ctx.activeOrgId), inviteApps(ctx)]);
  // Grants key on the app's row id, else its name — as the accepted invite writes them.
  const grantedAppIds = names.map((n) => apps.find((a) => a.name === n)?.id ?? n);
  return {
    role: args.role,
    stackNames: names,
    appCount: apps.length,
    verdicts: simulateInvite(policies, { orgId: ctx.activeOrgId, role: args.role, grantedAppIds }, apps),
  };
}
