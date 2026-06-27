import type { AuthzRequest, Decision, PolicyInput } from './types';
import { parsePolicyDoc, type PolicyDoc } from './policy';
import { JsonPolicyEngine, type IPolicyEngine } from './engine';

/**
 * Cedar engine path. We translate the same JSON-predicate policy documents into
 * Cedar policy source and evaluate them with `@cedar-policy/cedar-wasm`. This is a
 * *faithful adapter*: the produced Cedar reproduces our PARC semantics (action
 * match, role/attribute/label/relation conditions, forbid-wins) so a decision is
 * identical to the JSON engine for the supported document shape.
 *
 * Cedar is optional. If `@cedar-policy/cedar-wasm` is not installed, we cannot
 * construct the engine — {@link tryCreateCedarEngine} returns `null` and callers
 * fall back to the JSON engine. This keeps Cedar strictly behind a flag with no
 * hard dependency (the dep is listed as an INTEGRATION addition).
 */

/** Cedar entity-type names for our resources/principals. */
const PRINCIPAL_TYPE = 'Swarmy::User';
const RESOURCE_TYPES: Record<string, string> = {
  node: 'Swarmy::Node',
  service: 'Swarmy::Service',
  stack: 'Swarmy::Stack',
  org: 'Swarmy::Org',
  setting: 'Swarmy::Setting',
};

function resourceCedarType(type: string): string {
  return RESOURCE_TYPES[type] ?? `Swarmy::${type[0]?.toUpperCase()}${type.slice(1)}`;
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Translate one JSON policy document into a Cedar policy. We emit a wildcard head
 * (`permit(principal, action, resource)`) and push every clause into the `when`
 * condition referencing `context` records we populate at evaluation time. This
 * keeps the schema small and the translation total.
 */
export function policyDocToCedar(
  id: string,
  effect: 'permit' | 'forbid',
  doc: PolicyDoc,
): string {
  const conds: string[] = [];

  if (doc.actions && doc.actions.length && !doc.actions.includes('*')) {
    const list = doc.actions.map((a) => `"${esc(a)}"`).join(', ');
    conds.push(`[${list}].contains(context.action)`);
  }
  if (doc.roles && doc.roles.length && !doc.roles.includes('*')) {
    const list = doc.roles.map((r) => `"${esc(r)}"`).join(', ');
    conds.push(`context.roles.containsAny([${list}])`);
  }
  if (doc.resourceTypes && doc.resourceTypes.length && !doc.resourceTypes.includes('*')) {
    const list = doc.resourceTypes.map((t) => `"${esc(t)}"`).join(', ');
    conds.push(`context.hasResource && [${list}].contains(context.resourceType)`);
  }
  if (doc.resourceLabels) {
    for (const [k, v] of Object.entries(doc.resourceLabels)) {
      conds.push(`context.hasResource && context.labels has "${esc(k)}" && context.labels["${esc(k)}"] == ${cedarValue(v)}`);
    }
  }
  if (doc.attributes) {
    for (const [k, v] of Object.entries(doc.attributes)) {
      conds.push(`context.attributes has "${esc(k)}" && context.attributes["${esc(k)}"] == ${cedarValue(v)}`);
    }
  }
  if (doc.ownerOnly) {
    conds.push(`context.hasResource && context.isOwner`);
  }
  if (doc.relations && doc.relations.length) {
    const list = doc.relations.map((r) => `"${esc(r)}"`).join(', ');
    conds.push(`context.hasResource && context.relations.containsAny([${list}])`);
  }

  const annotation = `@id("${esc(id)}")\n`;
  const head = `${effect}(principal, action, resource)`;
  const body = conds.length ? ` when {\n  ${conds.join(' &&\n  ')}\n}` : '';
  return `${annotation}${head}${body};`;
}

function cedarValue(v: unknown): string {
  if (typeof v === 'string') return `"${esc(v)}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `"${esc(String(v))}"`;
}

/** The cedar-wasm surface we use (kept minimal so types don't require the dep). */
interface CedarWasm {
  isAuthorized(input: unknown): { type: string; response?: { decision: string } } | unknown;
}

export class CedarPolicyEngine implements IPolicyEngine {
  private readonly policies: { id: string; effect: 'permit' | 'forbid'; doc: PolicyDoc; priority: number }[];
  private readonly cedar: CedarWasm;
  private readonly fallback: JsonPolicyEngine;

  constructor(policies: PolicyInput[], cedar: CedarWasm) {
    this.cedar = cedar;
    this.fallback = new JsonPolicyEngine(policies);
    this.policies = policies
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        effect: p.effect,
        doc: parsePolicyDoc(p.source),
        priority: p.priority,
      }));
  }

  /** Render the whole policy set to a single Cedar source document. */
  toCedarSource(): string {
    return this.policies.map((p) => policyDocToCedar(p.id, p.effect, p.doc)).join('\n\n');
  }

  evaluate(req: AuthzRequest): Decision {
    // Build the Cedar context record from the PARC request.
    const ctx = buildCedarContext(req);
    try {
      const raw = this.cedar.isAuthorized({
        principal: `${PRINCIPAL_TYPE}::"${esc(req.principal.userId)}"`,
        action: 'Swarmy::Action::"act"',
        resource: req.resource
          ? `${resourceCedarType(req.resource.type)}::"${esc(req.resource.id)}"`
          : 'Swarmy::Org::"org"',
        context: ctx,
        policies: { staticPolicies: this.toCedarSource() },
        entities: [],
      });
      const decision = extractDecision(raw);
      if (decision) return decision;
    } catch {
      // Cedar failed at runtime — fall through to the JSON engine.
    }
    // Faithful fallback keeps decisions consistent if cedar-wasm misbehaves.
    return this.fallback.evaluate(req);
  }
}

function buildCedarContext(req: AuthzRequest): Record<string, unknown> {
  const r = req.resource;
  return {
    action: req.action,
    roles: req.principal.roles,
    attributes: req.principal.attributes,
    hasResource: Boolean(r),
    resourceType: r?.type ?? '',
    labels: r?.labels ?? {},
    relations: r?.principalRelations ?? [],
    isOwner:
      Boolean(r?.principalRelations?.includes('owner')) ||
      (Boolean(r?.ownerMemberId) && r?.ownerMemberId === req.principal.memberId),
  };
}

function extractDecision(raw: unknown): Decision | null {
  const r = raw as { response?: { decision?: string }; decision?: string } | undefined;
  const d = r?.response?.decision ?? r?.decision;
  if (d === 'allow' || d === 'Allow') return { decision: 'permit', policyId: null, reasons: ['cedar: allow'] };
  if (d === 'deny' || d === 'Deny') return { decision: 'deny', policyId: null, reasons: ['cedar: deny'] };
  return null;
}

/**
 * Attempt to construct a Cedar engine. Dynamically imports `@cedar-policy/cedar-wasm`;
 * returns `null` if the dependency is absent so callers transparently fall back to
 * the JSON engine. The import is wrapped so a missing module never throws upward.
 */
export async function tryCreateCedarEngine(policies: PolicyInput[]): Promise<CedarPolicyEngine | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ ('@cedar-policy/' + 'cedar-wasm')).catch(
      () => null,
    );
    if (!mod) return null;
    const cedar: CedarWasm = mod.default ?? mod;
    if (typeof cedar.isAuthorized !== 'function') return null;
    return new CedarPolicyEngine(policies, cedar);
  } catch {
    return null;
  }
}
