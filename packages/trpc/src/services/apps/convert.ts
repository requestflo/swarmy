/**
 * "Convert to swarmy.yaml" (epic-git-apps phase 5) for an app deployed from
 * compose: the compose swarmy deployed it from — the Stack's own source, the
 * input every deploy, redeploy and Release reads — through
 * `composeToAppConfig`, re-checked with the controller's parser so "valid ·
 * v1" is its word, with what changed shape and what didn't translate.
 *
 * Read-only: nothing is deployed and nothing is written to git (swarmy has no
 * git write path). Credentials in the compose never reach the file: literal
 * ones become `${{ secrets.<name> }}` (see from-compose-env.ts).
 */
import { TRPCError } from '@trpc/server';
import { composeToAppConfig, parseAppConfig, type ComposeGap } from '@swarmy/app-config';
import { buildInventory, isSystemStack, SYSTEM_STACK_LABEL } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { stacks } from '../apps.repo';

export interface ConvertToConfigView {
  stack: string;
  /** Where the file goes: the root of the repo. */
  path: 'swarmy.yaml';
  /** The generated swarmy.yaml; null when the compose has nothing to convert (`reason` says why). */
  yaml: string | null;
  /** The controller's parser found no errors. */
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  /** What changed shape on the way (a database became a managed resource, a URL a binding). */
  changes: string[];
  /** What didn't make it into the file, each with why. */
  untranslated: ComposeGap[];
  reason: string | null;
}

/** Pure: a compose source → the view (`app:` is the stack, so the git app keeps its name). */
export function conversionView(stack: string, composeSource: string): ConvertToConfigView {
  const r = composeToAppConfig(composeSource, { app: stack });
  const issues = r.yaml ? parseAppConfig(r.yaml).issues : [];
  return {
    stack,
    path: 'swarmy.yaml',
    yaml: r.yaml,
    valid: Boolean(r.yaml) && !issues.some((i) => i.severity === 'error'),
    issues: issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.line ? { line: i.line } : {}) })),
    changes: r.changes,
    untranslated: r.untranslated,
    reason: r.yaml ? null : (r.notes.at(-1) ?? 'There is nothing in the compose to convert.'),
  };
}

const refuse = (message: string): TRPCError => new TRPCError({ code: 'PRECONDITION_FAILED', message });

export async function convertToConfig(ctx: OrgContext, input: { stack: string }): Promise<ConvertToConfigView> {
  const { stack } = input;
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services.filter((s) => s.stack === stack);
  if (isSystemStack(stack) || live.some((s) => s.labels[SYSTEM_STACK_LABEL] === 'true')) {
    throw refuse(`swarmy manages ${stack} itself, so there's nothing to convert.`);
  }
  const plan = await ctx.db.appPlan.findFirst({ where: { orgId: ctx.activeOrgId, stack }, select: { id: true } });
  if (plan) throw refuse(`${stack} already runs from a swarmy.yaml in git.`);
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({ where: { orgId: ctx.activeOrgId, name: stack } });
  if (!row) {
    return {
      ...conversionView(stack, ''),
      reason: `swarmy didn't deploy ${stack} from compose, so it has no compose to convert.`,
    };
  }
  return conversionView(stack, row.composeSource);
}
