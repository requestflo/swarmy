/**
 * Clone as a new environment (board Environments): a long-lived environment
 * of a git app, made from the dashboard — its own stack `<app>-<name>` from a
 * branch, through the same engine as a push or a preview (`planCommit` with a
 * `clone`), so it gets the same plan, gates, check run, health gate and
 * audit. It is NOT a preview: no TTL, no `pr-N` host, never torn down by a
 * sweep or a branch delete. swarmy can't write to the repo, so it lives in
 * the dashboard until someone adds `environments.<name>` to swarmy.yaml.
 *
 * Secrets are never copied (each becomes an empty slot, filled write-only —
 * env-secrets.ts). With `database`, its Postgres starts as a copy of the
 * source environment's newest backup, masked by `previews.data.scrub` when
 * asked. Authorized as `stack.deploy` on the source stack (the router);
 * audited `app.environment.clone`.
 */
import type { DashboardEnvironment } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { commandRejected, notFound } from '../../errors';
import { writeAudit } from '../audit.service';
import type { PlanCommitInput, PlanCommitResult } from '../apps.service';
import { takenEnvironments } from './dashboard-envs';

export interface CloneEnvironmentInput {
  /** The stack of the environment being cloned (production or a named one). */
  stack: string;
  name: string;
  branch: string;
  /** Start its database as a copy of the source's newest backup. */
  database: boolean;
  /** Run the app's mask step (`previews.data.scrub`) on that copy. */
  mask: boolean;
}

export interface CloneEnvironmentResult extends PlanCommitResult {
  /** Where it lives until swarmy.yaml names it. */
  declared: 'dashboard';
}

type PlanFn = (ctx: OrgContext, input: PlanCommitInput) => Promise<PlanCommitResult>;

export async function cloneEnvironment(
  ctx: OrgContext,
  input: CloneEnvironmentInput,
  plan: PlanFn,
): Promise<CloneEnvironmentResult> {
  // The source: an environment (never a preview) a git app planned.
  const source = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, stack: input.stack, prNumber: 0, NOT: { environment: { in: ['?', 'preview'] } } },
    orderBy: { createdAt: 'desc' },
    select: { repoId: true, environment: true },
  });
  if (!source) throw notFound('git app environment', input.stack);
  if (input.mask && !input.database) throw commandRejected('masking applies to a copied database — turn on “start its database” too');
  // A removed environment's name is free again.
  if ((await takenEnvironments(ctx.db, source.repoId)).includes(input.name))
    throw commandRejected(`this app already has an environment called ${input.name}`);

  const clone: DashboardEnvironment = {
    name: input.name,
    branch: input.branch,
    from: source.environment,
    ...(input.database ? { data: { mask: input.mask } } : {}),
  };
  const audit = (metadata: Record<string, unknown>): Promise<void> =>
    writeAudit(ctx, {
      action: 'app.environment.clone',
      targetType: 'gitRepo',
      targetId: source.repoId,
      metadata: {
        environment: input.name,
        branch: input.branch,
        from: source.environment,
        fromStack: input.stack,
        database: input.database ? (input.mask ? 'copy-masked' : 'copy') : 'empty',
        ...metadata,
      },
    });
  let res: PlanCommitResult;
  try {
    res = await plan(ctx, { repoId: source.repoId, ref: input.branch, trigger: 'clone', clone });
  } catch (e) {
    await audit({ status: 'refused', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  await audit({ stack: res.stack, planId: res.planId, status: res.status });
  if (res.status === 'no-config') throw commandRejected(`${input.branch} has no swarmy.yaml to clone from`);
  return { ...res, declared: 'dashboard' };
}
