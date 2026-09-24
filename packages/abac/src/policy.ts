import type { Action, AuthzRequest, Effect, Principal, Resource } from './types';
import {
  CONDITION_OPS,
  conditionHolds,
  isAttrPath,
  lookupAttr,
  normaliseEnv,
  principalGroups,
  type Condition,
  type ConditionOp,
} from './attrs';

/**
 * A policy's `source` is a small JSON predicate document. This is the documented
 * MVP "fallback shape" — deliberately simple, with forbid-wins semantics — behind
 * the `PolicyEngine` interface, so a Cedar/CEL engine can replace it later without
 * touching `abacProcedure`.
 *
 * Matching is conjunctive across the populated clauses:
 *   - `actions`: the action must be in this list (or list contains "*").
 *   - `roles`: principal must hold at least one of these roles.
 *   - `resourceTypes`: resource.type must be in this list (or "*").
 *   - `resourceLabels`: every key/value must equal the resource's label.
 *   - `attributes`: every key/value must equal the principal's attribute.
 *   - `ownerOnly`: principal must own the resource (member or team owner edge).
 *   - `relations`: principal must hold at least one of these ReBAC relations on
 *     the resource (resolved from `ResourceGrant` edges — owner/operator/viewer).
 *   - `groups`: principal must be in at least one of these groups
 *     (Member.attributes.groups — SSO group claims — ∪ team ids).
 *   - `members`: principal must be one of these members (member or user id).
 *   - `conditions`: every attribute predicate must hold (see attrs.ts):
 *     `{ "attr": "resource.env", "op": "ne", "value": "production" }`.
 */
export interface PolicyDoc {
  actions?: string[];
  roles?: string[];
  resourceTypes?: string[];
  resourceLabels?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  ownerOnly?: boolean;
  relations?: string[];
  groups?: string[];
  members?: string[];
  conditions?: Condition[];
}

export interface ParsedPolicy {
  id: string;
  name: string;
  effect: Effect;
  priority: number;
  doc: PolicyDoc;
}

export class PolicyParseError extends Error {}

/** Parse + validate a policy source string into a {@link PolicyDoc}. Throws on
 * malformed JSON or structurally-invalid documents (used at write time). */
export function parsePolicyDoc(source: string): PolicyDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new PolicyParseError('policy source is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyParseError('policy source must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const doc: PolicyDoc = {};

  const strArray = (key: string): string[] | undefined => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new PolicyParseError(`"${key}" must be an array of strings`);
    }
    return v as string[];
  };
  const record = (key: string): Record<string, unknown> | undefined => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new PolicyParseError(`"${key}" must be an object`);
    }
    return v as Record<string, unknown>;
  };

  doc.actions = strArray('actions');
  doc.roles = strArray('roles');
  doc.resourceTypes = strArray('resourceTypes');
  doc.resourceLabels = record('resourceLabels');
  doc.attributes = record('attributes');
  if (obj.ownerOnly !== undefined) {
    if (typeof obj.ownerOnly !== 'boolean') {
      throw new PolicyParseError('"ownerOnly" must be a boolean');
    }
    doc.ownerOnly = obj.ownerOnly;
  }
  doc.relations = strArray('relations');
  if (doc.relations) {
    const allowed = new Set(['owner', 'operator', 'viewer']);
    for (const r of doc.relations) {
      if (!allowed.has(r)) {
        throw new PolicyParseError(`"relations" must contain only owner|operator|viewer (got "${r}")`);
      }
    }
  }
  doc.groups = strArray('groups');
  doc.members = strArray('members');
  if (obj.conditions !== undefined) doc.conditions = parseConditions(obj.conditions);
  // Drop absent keys so a parsed doc round-trips to the same JSON.
  for (const k of Object.keys(doc) as (keyof PolicyDoc)[]) if (doc[k] === undefined) delete doc[k];
  return doc;
}

function parseConditions(raw: unknown): Condition[] {
  if (!Array.isArray(raw)) throw new PolicyParseError('"conditions" must be an array');
  return raw.map((c, i): Condition => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new PolicyParseError(`conditions[${i}] must be an object`);
    }
    const { attr, op, value } = c as Record<string, unknown>;
    if (typeof attr !== 'string' || !isAttrPath(attr)) {
      throw new PolicyParseError(
        `conditions[${i}].attr must be resource.env | resource.type | resource.id | resource.label.<key> | principal.<key>`,
      );
    }
    if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) {
      throw new PolicyParseError(`conditions[${i}].op must be one of ${CONDITION_OPS.join(' | ')}`);
    }
    const norm = (v: string) => (attr === 'resource.env' ? (normaliseEnv(v) ?? v) : v);
    if (op === 'eq' || op === 'ne') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new PolicyParseError(`conditions[${i}].value must be a string for "${op}"`);
      }
      return { attr, op: op as ConditionOp, value: norm(String(value)) };
    }
    if (op === 'in' || op === 'notIn') {
      if (!Array.isArray(value) || value.length === 0 || !value.every((x) => typeof x === 'string')) {
        throw new PolicyParseError(`conditions[${i}].value must be a non-empty string array for "${op}"`);
      }
      return { attr, op: op as ConditionOp, value: (value as string[]).map(norm) };
    }
    return { attr, op: op as ConditionOp };
  });
}

function listMatches(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true;
  return list.includes('*') || list.includes(value);
}

function principalTeamIds(principal: Principal): string[] {
  if (principal.teamIds && principal.teamIds.length) return principal.teamIds;
  return Array.isArray(principal.attributes.teamIds)
    ? (principal.attributes.teamIds as unknown[]).map(String)
    : [];
}

function ownsResource(principal: Principal, resource: Resource): boolean {
  // A resolved `owner` ReBAC relation counts as ownership.
  if (resource.principalRelations?.includes('owner')) return true;
  const teamIds = principalTeamIds(principal);
  const memberId = principal.memberId ?? null;
  if (resource.ownerMemberId && (resource.ownerMemberId === memberId || resource.ownerMemberId === principal.userId))
    return true;
  if (resource.ownerTeamId && teamIds.includes(resource.ownerTeamId)) return true;
  return false;
}

/** Does this policy match the request? */
export function policyMatches(policy: ParsedPolicy, req: AuthzRequest): boolean {
  const { doc } = policy;
  const { principal, resource } = req;

  if (!listMatches(doc.actions, req.action as Action)) return false;

  if (doc.roles && doc.roles.length > 0) {
    const principalRoles: string[] = principal.roles;
    if (!doc.roles.includes('*') && !doc.roles.some((r) => principalRoles.includes(r)))
      return false;
  }

  if (doc.resourceTypes && doc.resourceTypes.length > 0) {
    if (!resource || !listMatches(doc.resourceTypes, resource.type)) return false;
  }

  if (doc.resourceLabels) {
    if (!resource) return false;
    for (const [k, v] of Object.entries(doc.resourceLabels)) {
      if (resource.labels[k] !== v) return false;
    }
  }

  if (doc.attributes) {
    for (const [k, v] of Object.entries(doc.attributes)) {
      if (principal.attributes[k] !== v) return false;
    }
  }

  if (doc.ownerOnly) {
    if (!resource || !ownsResource(principal, resource)) return false;
  }

  if (doc.relations && doc.relations.length > 0) {
    if (!resource) return false;
    const held = resource.principalRelations ?? [];
    if (!doc.relations.some((r) => held.includes(r as never))) return false;
  }

  if (doc.groups && doc.groups.length > 0) {
    const mine = principalGroups(principal);
    if (!doc.groups.includes('*') && !doc.groups.some((g) => mine.includes(g))) return false;
  }

  if (doc.members && doc.members.length > 0) {
    const ids = [principal.memberId, principal.userId].filter(Boolean) as string[];
    if (!doc.members.some((m) => ids.includes(m))) return false;
  }

  for (const cond of doc.conditions ?? []) {
    if (!conditionHolds(cond, lookupAttr(cond.attr, principal, resource))) return false;
  }

  return true;
}
