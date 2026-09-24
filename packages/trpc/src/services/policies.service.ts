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
  const row = await policyRepo(ctx.db).upsert(ctx.activeOrgId, args, ctx.user.id);
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
 * Replace the org's default rows with the current seeded set. The upgrade path
 * for orgs whose defaults were persisted before the attribute-based model;
 * custom rules are untouched.
 */
export async function resetDefaultPolicies(ctx: OrgContext): Promise<PolicyView[]> {
  await policyRepo(ctx.db).resetDefaults(ctx.activeOrgId, ctx.user.id);
  await writeAudit(ctx, { action: 'policy.resetDefaults', targetType: 'org', targetId: ctx.activeOrgId });
  return listPolicies(ctx);
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

/** The action catalogue + the JSON policy-doc schema, for the UI builder. */
export function policySchema() {
  return {
    actions: [...ACTIONS],
    actionCatalog: ACTION_CATALOG,
    conditionOps: [...CONDITION_OPS],
    attributes: [
      { key: 'resource.env', label: 'Environment', hint: 'from the swarmy.env label; prod → production' },
      { key: 'resource.type', label: 'Resource type', hint: 'node | service | stack' },
      { key: 'resource.label.<key>', label: 'App / stack label', hint: 'any Docker label on the resource' },
      { key: 'principal.groups', label: 'Groups', hint: 'member groups, SSO group claims, teams' },
      { key: 'principal.<key>', label: 'Member attribute', hint: 'any key of the member attribute bag' },
    ],
    relations: ['owner', 'operator', 'viewer'],
    clauses: [
      { key: 'actions', label: 'Actions', type: 'string[]', hint: 'allowed actions, or ["*"]' },
      { key: 'roles', label: 'Roles', type: 'string[]', hint: 'owner | admin | member' },
      { key: 'resourceTypes', label: 'Resource types', type: 'string[]', hint: 'node | service | stack' },
      { key: 'resourceLabels', label: 'Resource labels', type: 'object', hint: 'e.g. { "env": "staging" }' },
      { key: 'attributes', label: 'Subject attributes', type: 'object', hint: 'e.g. { "team": "payments" }' },
      { key: 'relations', label: 'ReBAC relations', type: 'string[]', hint: 'owner | operator | viewer' },
      { key: 'ownerOnly', label: 'Owner only', type: 'boolean', hint: 'principal must own the resource' },
      { key: 'groups', label: 'Groups', type: 'string[]', hint: 'member is in any of these groups' },
      { key: 'members', label: 'People', type: 'string[]', hint: 'member ids' },
      { key: 'conditions', label: 'Conditions', type: 'condition[]', hint: '{ attr, op, value }' },
    ],
  };
}
