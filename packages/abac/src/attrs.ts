import type { Principal, Resource } from './types';

/**
 * Attribute resolution shared by BOTH engines (JSON evaluates it directly; the
 * Cedar adapter pre-computes the same values into its context), so a condition
 * can never mean two different things.
 *
 * Attribute paths:
 *   - `resource.env`          normalised environment (see {@link normaliseEnv})
 *   - `resource.type` / `resource.id`
 *   - `resource.label.<key>`  a Docker label on the resource (app/stack labels)
 *   - `principal.role`        the member's role(s)
 *   - `principal.groups`      Member.attributes.groups ∪ ssoGroups ∪ teamIds
 *   - `principal.<key>`       any key of Member.attributes
 *
 * Every attribute resolves to a list of strings (empty = unset), so `eq` on a
 * list-valued attribute means "contains".
 */

/** The Docker label that marks a stack/service's environment (Docker truth). */
export const ENV_LABEL = 'swarmy.env';
/** Git-apps stamp their environment here; read as a fallback. */
export const APP_ENV_LABEL = 'swarmy.app.environment';
export const PRODUCTION = 'production';

const ENV_ALIASES: Record<string, string> = {
  prod: PRODUCTION,
  prd: PRODUCTION,
  production: PRODUCTION,
  live: PRODUCTION,
  stage: 'staging',
  staging: 'staging',
  stg: 'staging',
  dev: 'development',
  development: 'development',
  preview: 'preview',
  test: 'test',
};

/** `prod`/`production`/`PRD` → `production`, `stage` → `staging`, blank → null. */
export function normaliseEnv(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return ENV_ALIASES[v] ?? v;
}

/** A resource's environment: explicit `env`, else its `swarmy.env` / app label. */
export function resourceEnv(resource: Pick<Resource, 'env' | 'labels'> | null | undefined): string | null {
  if (!resource) return null;
  if (resource.env !== undefined && resource.env !== null) return normaliseEnv(resource.env);
  return normaliseEnv(resource.labels?.[ENV_LABEL]) ?? normaliseEnv(resource.labels?.[APP_ENV_LABEL]);
}

function strings(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null).map(String);
  if (typeof v === 'object') return [];
  return [String(v)];
}

/**
 * Groups from a `Member.attributes` bag: admin-set `groups` ∪ IdP-derived
 * `ssoGroups` (replaced on every SSO login) ∪ `teamIds`. Pure; shared by the
 * policy engine, the SSO group sync and the OIDC provider's groups claim.
 */
export function groupsFromAttributes(attributes: Record<string, unknown> | null | undefined): string[] {
  const a = attributes ?? {};
  return [...new Set([...strings(a.groups), ...strings(a.ssoGroups), ...strings(a.teamIds)])];
}

/** Groups the principal is in: explicit `groups` ∪ team ids ∪ {@link groupsFromAttributes}. */
export function principalGroups(principal: Principal): string[] {
  return [
    ...new Set([...(principal.groups ?? []), ...(principal.teamIds ?? []), ...groupsFromAttributes(principal.attributes)]),
  ];
}

export const RESOURCE_ATTRS = ['resource.env', 'resource.type', 'resource.id'] as const;
export const RESOURCE_LABEL_PREFIX = 'resource.label.';
export const PRINCIPAL_PREFIX = 'principal.';

/** Is `attr` a well-formed attribute path? */
export function isAttrPath(attr: string): boolean {
  if ((RESOURCE_ATTRS as readonly string[]).includes(attr)) return true;
  if (attr.startsWith(RESOURCE_LABEL_PREFIX)) return attr.length > RESOURCE_LABEL_PREFIX.length;
  if (attr.startsWith(PRINCIPAL_PREFIX)) return attr.length > PRINCIPAL_PREFIX.length;
  return false;
}

/** Resolve one attribute path to its string values (empty when unset / no resource). */
export function lookupAttr(attr: string, principal: Principal, resource: Resource | null | undefined): string[] {
  if (attr === 'resource.env') return strings(resourceEnv(resource));
  if (attr === 'resource.type') return strings(resource?.type);
  if (attr === 'resource.id') return strings(resource?.id);
  if (attr.startsWith(RESOURCE_LABEL_PREFIX)) {
    return strings(resource?.labels?.[attr.slice(RESOURCE_LABEL_PREFIX.length)]);
  }
  if (attr === 'principal.role') return [...principal.roles];
  if (attr === 'principal.groups') return principalGroups(principal);
  if (attr.startsWith(PRINCIPAL_PREFIX)) return strings(principal.attributes[attr.slice(PRINCIPAL_PREFIX.length)]);
  return [];
}

export const CONDITION_OPS = ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * One attribute predicate. `eq`/`ne` take a scalar `value`; `in`/`notIn` a list;
 * `exists`/`notExists` none. A missing attribute is "not equal" to anything —
 * so `resource.env ne production` holds for an org-scoped (no resource) action
 * and for an unlabelled app: unknown env counts as non-production.
 */
export interface Condition {
  attr: string;
  op: ConditionOp;
  value?: string | string[];
}

/** Evaluate a condition against resolved attribute values. */
export function conditionHolds(cond: Condition, values: string[]): boolean {
  switch (cond.op) {
    case 'eq':
      return values.includes(String(cond.value));
    case 'ne':
      return !values.includes(String(cond.value));
    case 'in':
      return values.some((v) => (cond.value as string[]).includes(v));
    case 'notIn':
      return !values.some((v) => (cond.value as string[]).includes(v));
    case 'exists':
      return values.length > 0;
    case 'notExists':
      return values.length === 0;
  }
}
