import type { AuthzRequest, Decision, Effect, PolicyInput } from './types';
import { parsePolicyDoc, policyMatches, type ParsedPolicy } from './policy';
import { DEFAULT_POLICY_SPECS } from './defaults';

/**
 * The framework-agnostic policy engine. Loads an org's compiled policy set and
 * evaluates a PARC request to permit/deny + the deciding policy id.
 *
 * Semantics: **forbid wins**. If any matching `forbid` applies, the result is
 * deny. Otherwise, if any `permit` matches, the result is permit (highest
 * priority reported as the deciding policy). With no match, the result is deny
 * (default-deny).
 */
export class PolicyEngine {
  private readonly compiled: ParsedPolicy[];

  constructor(policies: PolicyInput[]) {
    this.compiled = policies
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        name: p.name,
        effect: p.effect,
        priority: p.priority,
        doc: parsePolicyDoc(p.source),
      }));
  }

  /** Build an engine from the seeded default policy set (zero custom policies). */
  static withDefaults(): PolicyEngine {
    return new PolicyEngine(
      DEFAULT_POLICY_SPECS.map((spec) => ({
        id: `default:${spec.key}`,
        name: spec.name,
        effect: spec.effect as Effect,
        source: JSON.stringify(spec.doc),
        priority: spec.priority,
        enabled: true,
      })),
    );
  }

  evaluate(req: AuthzRequest): Decision {
    const matches = this.compiled.filter((p) => policyMatches(p, req));
    const forbids = matches.filter((p) => p.effect === 'forbid');
    if (forbids.length > 0) {
      const top = forbids.sort((a, b) => b.priority - a.priority)[0]!;
      return {
        decision: 'deny',
        policyId: top.id,
        reasons: [`forbidden by policy "${top.name}"`],
      };
    }
    const permits = matches.filter((p) => p.effect === 'permit');
    if (permits.length > 0) {
      const top = permits.sort((a, b) => b.priority - a.priority)[0]!;
      return {
        decision: 'permit',
        policyId: top.id,
        reasons: [`permitted by policy "${top.name}"`],
      };
    }
    return { decision: 'deny', policyId: null, reasons: ['no matching permit (default deny)'] };
  }
}
