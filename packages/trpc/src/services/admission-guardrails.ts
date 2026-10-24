import type { GuardrailRuleId, GuardrailSeverity, GuardrailsConfigView } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';
import { estateFor, guardrailFacts } from './admission-guardrails-facts';
import { isLatestImage, type GuardrailSpecFacts } from './admission-guardrails-specs';

export { isLatestImage, specFacts, type GuardrailSpecFacts } from './admission-guardrails-specs';

/**
 * Guardrails admission evaluator (slice E4) — enforces `GuardrailConfig.rulesJson`
 * against what a deploy is ABOUT to do. "Prod" is the `swarmy.env=production`
 * stack label (Docker truth, read from live inventory or the incoming specs);
 * prod-scoped rules stay silent everywhere else. When `productionSafetyMode` is
 * ON, every rule is enforced at `block` severity on production stacks —
 * per-rule settings still govern non-production deploys.
 *
 * `requireSignedImagesProd` delegates: when D3's registry policy already
 * enforces signatures (`RegistryConfig.requireSignedImages`), this evaluator
 * emits nothing — the image-policy evaluator does the real cosign verify.
 *
 * The evaluator only decides. The admission gate records every decision
 * (`admission-record.ts`), and `admission-guardrails-shadow.ts` re-runs the
 * Warn and Off rules at Block over the same facts for "would have blocked".
 */

// ── Pure: effective rule resolution ───────────────────────────────────────────

export interface EffectiveRule {
  severity: GuardrailSeverity;
  params: Record<string, number>;
}

/**
 * Which rules apply to this intent, at what severity. Safety mode ON + prod
 * target ⇒ every rule active at `block` (per-rule params still respected);
 * otherwise per-rule `enabled`/`severity` apply. Prod-scoped rules never
 * activate for non-production targets.
 */
export function effectiveRules(
  config: GuardrailsConfigView,
  isProd: boolean,
): Map<GuardrailRuleId, EffectiveRule> {
  const out = new Map<GuardrailRuleId, EffectiveRule>();
  const forced = config.productionSafetyMode && isProd;
  for (const rule of config.rules) {
    if (rule.prodOnly && !isProd) continue;
    if (!forced && !rule.enabled) continue;
    out.set(rule.id, { severity: forced ? 'block' : rule.severity, params: rule.params });
  }
  return out;
}

// ── Pure: the decision core (unit-tested per rule) ────────────────────────────

/** One managed db cluster relevant to the intent's stack. */
export interface DbClusterFact {
  cluster: string;
  declaredReplicas: number;
  hasBackupSchedule: boolean;
}

export interface GuardrailEstateFacts {
  dbClusters: DbClusterFact[];
  /** Org has (unpaused) volume-level BackupSchedule rows — the policy fallback. */
  hasOrgBackupSchedules: boolean;
  /** D3's `RegistryConfig.requireSignedImages` is ON — this evaluator defers. */
  signingEnforced: boolean;
}

export function decideGuardrails(input: {
  rules: Map<GuardrailRuleId, EffectiveRule>;
  isProd: boolean;
  stackName: string | undefined;
  specs: GuardrailSpecFacts[];
  estate: GuardrailEstateFacts;
}): Violation[] {
  const { rules, specs, estate } = input;
  const stack = input.stackName ?? 'this deploy';
  const violations: Violation[] = [];

  const latest = rules.get('noLatestTagInProd');
  if (latest) {
    for (const spec of specs) {
      if (!spec.image || !isLatestImage(spec.image)) continue;
      violations.push({
        rule: 'guardrails/no-latest-tag-in-prod',
        severity: latest.severity,
        message: `${spec.name} would deploy ${spec.image} to production — pin a version tag so rollbacks mean something.`,
        resource: spec.name,
      });
    }
  }

  const minDb = rules.get('minDbReplicasProd');
  if (minDb) {
    const n = minDb.params.n ?? 2;
    for (const c of estate.dbClusters) {
      if (c.declaredReplicas >= n) continue;
      violations.push({
        rule: 'guardrails/min-db-replicas-prod',
        severity: minDb.severity,
        message: `Database cluster ${c.cluster} runs ${c.declaredReplicas} read replica${c.declaredReplicas === 1 ? '' : 's'} in production — guardrails require at least ${n}.`,
        resource: c.cluster,
      });
    }
  }

  const backup = rules.get('requireBackupPolicy');
  if (
    backup &&
    estate.dbClusters.length > 0 &&
    !estate.dbClusters.some((c) => c.hasBackupSchedule) &&
    !estate.hasOrgBackupSchedules
  ) {
    violations.push({
      rule: 'guardrails/require-backup-policy',
      severity: backup.severity,
      message: `${stack} has a database but no backup policy — set a backup schedule before shipping data you can't lose.`,
      resource: input.stackName,
    });
  }

  const health = rules.get('requireHealthcheck');
  if (health) {
    for (const spec of specs) {
      if (spec.hasHealthcheck) continue;
      violations.push({
        rule: 'guardrails/require-healthcheck',
        severity: health.severity,
        message: `${spec.name} defines no healthcheck — swarm can't tell healthy from wedged.`,
        resource: spec.name,
      });
    }
  }

  const limits = rules.get('requireResourceLimits');
  if (limits) {
    for (const spec of specs) {
      if (spec.hasMemoryLimit) continue;
      violations.push({
        rule: 'guardrails/require-resource-limits',
        severity: limits.severity,
        message: `${spec.name} sets no memory limit — one leak can take the whole node down.`,
        resource: spec.name,
      });
    }
  }

  const signed = rules.get('requireSignedImagesProd');
  if (signed && !estate.signingEnforced && specs.some((s) => s.image)) {
    violations.push({
      rule: 'guardrails/require-signed-images-prod',
      severity: signed.severity,
      message: `Production requires signed images, but registry signing enforcement is off — enable "Require signed images" in Registry policy (or override).`,
      resource: input.stackName,
    });
  }

  const priv = rules.get('noPrivilegedContainers');
  if (priv) {
    for (const spec of specs) {
      if (!spec.privileged) continue;
      violations.push({
        rule: 'guardrails/no-privileged-containers',
        severity: priv.severity,
        message: `${spec.name} requests privileged mode — that's root on the host; grant specific capabilities instead.`,
        resource: spec.name,
      });
    }
  }

  const hostPorts = rules.get('noHostPortsProd');
  if (hostPorts) {
    for (const spec of specs) {
      if (spec.hostPorts.length === 0) continue;
      violations.push({
        rule: 'guardrails/no-host-ports-prod',
        severity: hostPorts.severity,
        message: `${spec.name} binds host port${spec.hostPorts.length === 1 ? '' : 's'} ${spec.hostPorts.join(', ')} in production — publish through the routing mesh or the ingress instead.`,
        resource: spec.name,
      });
    }
  }

  return violations;
}

// ── Evaluator (spine contract) ───────────────────────────────────────────────

export async function evaluate(ctx: OrgContext, intent: AdmissionIntent): Promise<Violation[]> {
  const facts = await guardrailFacts(ctx, intent);
  if (!facts) return [];
  const rules = effectiveRules(facts.config, facts.isProd);
  if (rules.size === 0) return [];
  return decideGuardrails({
    rules,
    isProd: facts.isProd,
    stackName: intent.stackName,
    specs: facts.specs,
    estate: await estateFor(facts, new Set(rules.keys())),
  });
}
