import {
  parsePolicyDoc,
  PolicyParseError,
  ACTIONS,
  ACTION_CATALOG,
  CONDITION_OPS,
  isAction,
  describePolicy,
} from '@swarmy/abac';
import type { Action, PolicyDoc, ResourceInput } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { evaluateAccess, resolveNode, resolveService, resolveStack, whoCan, type WhoCanRow } from '../abac';
import { policyRepo, type PolicyRecord } from './policy-repo';

export interface PolicyView extends PolicyRecord {
  /** The rule in plain words ("Members of platform can deploy apps …"). */
  sentence: string;
  /** The parsed document (null when the stored source no longer parses). */
  doc: PolicyDoc | null;
}

function toView(row: PolicyRecord): PolicyView {
  let doc: PolicyDoc | null = null;
  try {
    doc = parsePolicyDoc(row.source);
  } catch {
    doc = null;
  }
  return {
    ...row,
    doc,
    sentence: doc ? describePolicy(row.effect, doc) : 'This rule no longer parses; edit its JSON.',
  };
}

/**
 * Seed the default policy set the first time the policy UI is opened, and top
 * up defaults added since (idempotent, additive — see PolicyRepository).
 */
export async function ensureDefaultPolicies(ctx: OrgContext): Promise<void> {
  await policyRepo(ctx.db).ensureDefaults(ctx.activeOrgId, ctx.user.id);
}

export async function listPolicies(ctx: OrgContext): Promise<PolicyView[]> {
  await ensureDefaultPolicies(ctx);
  return (await policyRepo(ctx.db).list(ctx.activeOrgId)).map(toView);
}

export interface SetPolicyArgs {
  id?: string;
  name: string;
  description?: string;
  effect: 'permit' | 'forbid';
  source: string;
  priority?: number;
  enabled?: boolean;
}

/** Create or update a policy. Validates the source document before persisting. */
export async function setPolicy(ctx: OrgContext, args: SetPolicyArgs): Promise<PolicyView> {
  try {
    parsePolicyDoc(args.source);
  } catch (e) {
    if (e instanceof PolicyParseError) {
      throw new Error(`invalid policy: ${e.message}`);
    }
    throw e;
  }
  const repo = policyRepo(ctx.db);
  if (args.id) {
    // Default rules are managed by swarmy (kept equal to the shipped set): an
    // admin may turn one off or on, not rewrite it.
    const existing = await repo.get(ctx.activeOrgId, args.id);
    if (existing?.isDefault) {
      const rewritten =
        existing.source !== args.source ||
        existing.effect !== args.effect ||
        (args.priority !== undefined && existing.priority !== args.priority);
      if (rewritten) {
        throw new Error('Default rules are managed by swarmy. Turn this one off, or add your own rule (a forbid overrides).');
      }
    }
  }
  const row = await repo.upsert(ctx.activeOrgId, args, ctx.user.id);
  if (!row) throw notFound('policy', args.id ?? '');
  await writeAudit(ctx, {
    action: args.id ? 'policy.update' : 'policy.create',
    targetType: 'policy',
    targetId: row.id,
    metadata: { name: row.name, effect: row.effect },
  });
  return toView(row);
}

export async function deletePolicy(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const repo = policyRepo(ctx.db);
  const row = await repo.get(ctx.activeOrgId, id);
  if (!row) throw notFound('policy', id);
  if (row.isDefault) throw new Error('default policies cannot be deleted');
  await repo.delete(ctx.activeOrgId, id);
  await writeAudit(ctx, { action: 'policy.delete', targetType: 'policy', targetId: id });
  return { id, deleted: true };
}

/**
 * Compile-only validation: parse the policy source without persisting. Returns
 * the recognised clauses (so the UI can confirm what it understood) or the parse
 * error message. The "validate-on-type" path for the editor.
 */
export function validatePolicy(
  source: string,
  effect: 'permit' | 'forbid' = 'permit',
): { valid: boolean; error?: string; doc?: PolicyDoc; sentence?: string } {
  try {
    const doc = parsePolicyDoc(source);
    return { valid: true, doc, sentence: describePolicy(effect, doc) };
  } catch (e) {
    return { valid: false, error: e instanceof PolicyParseError ? e.message : String(e) };
  }
}

export interface SimulateArgs {
  action: string;
  resourceType?: 'node' | 'service' | 'stack';
  resourceId?: string;
}

/**
 * The "why can't X do Y?" debugger. Runs a PARC request for the *current* user
 * (principal) against the org's live policies and reports permit/deny + the
 * deciding policy id — the exact decision path `abacProcedure` would take.
 */
export async function simulatePolicy(ctx: OrgContext, args: SimulateArgs) {
  if (!isAction(args.action)) {
    throw new Error(`unknown action "${args.action}"`);
  }
  const action: Action = args.action;
  let resource: ResourceInput | null = null;
  if (args.resourceType && args.resourceId) {
    const resolver = { node: resolveNode, service: resolveService, stack: resolveStack }[args.resourceType];
    resource = (await resolver(ctx, { id: args.resourceId })) ?? {
      type: args.resourceType,
      id: args.resourceId,
      orgId: ctx.activeOrgId,
      labels: {},
    };
  }
  const result = await evaluateAccess(ctx, action, resource);
  return {
    decision: result.decision,
    policyId: result.policyId,
    reasons: result.reasons,
  };
}

export interface WhoCanArgs {
  action: string;
  resourceType?: 'node' | 'service' | 'stack';
  /** A real resource: its live labels/env are resolved. */
  resourceId?: string;
  /** A hypothetical resource ("an app where env = production"). */
  env?: string;
  labels?: Record<string, string>;
}

/**
 * "Who can do X?" — every member's decision for one action on one resource
 * (real, or hypothetical from env/labels), through the same decision path as
 * enforcement. No audit: it decides nothing.
 */
export async function whoCanPolicy(
  ctx: OrgContext,
  args: WhoCanArgs,
): Promise<{ action: Action; resource: ResourceInput | null; rows: WhoCanRow[] }> {
  if (!isAction(args.action)) throw new Error(`unknown action "${args.action}"`);
  let resource: ResourceInput | null = null;
  if (args.resourceType && args.resourceId) {
    const resolver = { node: resolveNode, service: resolveService, stack: resolveStack }[args.resourceType];
    resource = (await resolver(ctx, { id: args.resourceId })) ?? null;
    if (!resource) throw notFound(args.resourceType, args.resourceId);
  } else if (args.resourceType || args.env || (args.labels && Object.keys(args.labels).length)) {
    resource = {
      type: args.resourceType ?? 'service',
      id: '(any)',
      orgId: ctx.activeOrgId,
      labels: { ...(args.labels ?? {}) },
      ...(args.env ? { env: args.env } : {}),
    };
  }
  return { action: args.action, resource, rows: await whoCan(ctx.db, ctx.activeOrgId, args.action, resource) };
}
