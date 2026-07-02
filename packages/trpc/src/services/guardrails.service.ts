import {
  buildInventory,
  GUARDRAIL_RULE_IDS,
  UNGROUPED,
  type GuardrailDecisionView,
  type GuardrailDecisionViolation,
  type GuardrailRuleId,
  type GuardrailRuleView,
  type GuardrailSeverity,
  type GuardrailsConfigView,
  type GuardrailDecisionsInput,
  type SetGuardrailRuleInput,
  type SetGuardrailSafetyModeInput,
  type SetStackEnvInput,
  type StackEnvView,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

/**
 * Guardrails (slice E4) — deployment guardrails / production safety mode.
 *
 * Persistence is deliberately thin: the one-per-org `GuardrailConfig` row holds
 * the rule toggles (`rulesJson`, an array of `{id, enabled, severity, params}`)
 * plus the `productionSafetyMode` master switch. Everything else is Docker
 * truth: "this stack is production" is the `swarmy.env=production` label on the
 * stack's services (written via `service.updateLabels`, read from live
 * inventory), and the blocked/overridden feed is a query over the AuditLog
 * entries the admission pipeline writes.
 *
 * Enforcement itself lives in `admission-guardrails.ts` (the evaluator the
 * spine's admission pipeline calls on every deploy-shaped mutation).
 */

// ── Docker-truth label scheme ─────────────────────────────────────────────────

/** Stack-level environment marker, stamped on every service of the stack. */
export const ENV_LABEL = 'swarmy.env';
/** The `swarmy.env` value that arms the prod-scoped guardrails. */
export const PRODUCTION_ENV = 'production';

// ── Rule defaults ─────────────────────────────────────────────────────────────

interface RuleDefault {
  enabled: boolean;
  severity: GuardrailSeverity;
  params: Record<string, number>;
  prodOnly: boolean;
}

/**
 * Default rule set, seeded on first read. Prod-scoped rules ship enabled — they
 * only bite once a stack is explicitly marked production. Estate-wide hygiene
 * rules (healthcheck / limits / backup policy) ship disabled so guardrails
 * never surprise-refuse a dev deploy; enabling them is a deliberate act.
 */
export const GUARDRAIL_DEFAULTS: Record<GuardrailRuleId, RuleDefault> = {
  noLatestTagInProd: { enabled: true, severity: 'block', params: {}, prodOnly: true },
  minDbReplicasProd: { enabled: true, severity: 'block', params: { n: 2 }, prodOnly: true },
  requireBackupPolicy: { enabled: false, severity: 'warn', params: {}, prodOnly: false },
  requireHealthcheck: { enabled: false, severity: 'warn', params: {}, prodOnly: false },
  requireResourceLimits: { enabled: false, severity: 'warn', params: {}, prodOnly: false },
  requireSignedImagesProd: { enabled: false, severity: 'block', params: {}, prodOnly: true },
  noPrivilegedContainers: { enabled: true, severity: 'block', params: {}, prodOnly: false },
  noHostPortsProd: { enabled: true, severity: 'warn', params: {}, prodOnly: true },
};

/** The full default rule list (fresh copies, display order). */
export function defaultGuardrailRules(): GuardrailRuleView[] {
  return GUARDRAIL_RULE_IDS.map((id) => ({ id, ...GUARDRAIL_DEFAULTS[id], params: { ...GUARDRAIL_DEFAULTS[id].params } }));
}

// ── Pure: rulesJson codec ─────────────────────────────────────────────────────

/**
 * Parse `GuardrailConfig.rulesJson` (`[{id, enabled, severity, params}]`) over
 * the defaults. Unknown ids and malformed entries are dropped; missing rules
 * fall back to their default — the stored array can never brick the gate.
 */
export function parseGuardrailRules(rulesJson: unknown): GuardrailRuleView[] {
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rulesJson)) {
    for (const raw of rulesJson) {
      if (typeof raw !== 'object' || raw === null) continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.id === 'string') byId.set(o.id, o);
    }
  }
  return GUARDRAIL_RULE_IDS.map((id) => {
    const def = GUARDRAIL_DEFAULTS[id];
    const o = byId.get(id);
    const params: Record<string, number> = { ...def.params };
    if (o && typeof o.params === 'object' && o.params !== null) {
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
      }
    }
    return {
      id,
      enabled: typeof o?.enabled === 'boolean' ? o.enabled : def.enabled,
      severity: o?.severity === 'block' || o?.severity === 'warn' ? o.severity : def.severity,
      params,
      prodOnly: def.prodOnly,
    };
  });
}

/** Encode rules for storage (`prodOnly` is derived, never persisted). */
export function encodeGuardrailRules(
  rules: GuardrailRuleView[],
): Array<{ id: string; enabled: boolean; severity: GuardrailSeverity; params: Record<string, number> }> {
  return rules.map((r) => ({ id: r.id, enabled: r.enabled, severity: r.severity, params: r.params }));
}

// ── Config: get/set ───────────────────────────────────────────────────────────

/** The org's guardrail config; seeds the default row on first read. */
export async function getConfig(ctx: OrgContext): Promise<GuardrailsConfigView> {
  const row = await ctx.db.guardrailConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      rulesJson: encodeGuardrailRules(defaultGuardrailRules()),
      productionSafetyMode: false,
    },
    update: {},
    select: { rulesJson: true, productionSafetyMode: true },
  });
  return { productionSafetyMode: row.productionSafetyMode, rules: parseGuardrailRules(row.rulesJson) };
}

/** Read-only config for the admission evaluator (no seeding writes). */
export async function readConfig(ctx: OrgContext): Promise<GuardrailsConfigView> {
  const row = await ctx.db.guardrailConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { rulesJson: true, productionSafetyMode: true },
  });
  if (!row) return { productionSafetyMode: false, rules: defaultGuardrailRules() };
  return { productionSafetyMode: row.productionSafetyMode, rules: parseGuardrailRules(row.rulesJson) };
}

/** Flip the production-safety master switch (audited). */
export async function setSafetyMode(
  ctx: OrgContext,
  input: SetGuardrailSafetyModeInput,
): Promise<GuardrailsConfigView> {
  await getConfig(ctx); // ensure the row exists
  await ctx.db.guardrailConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { productionSafetyMode: input.enabled },
  });
  await writeAudit(ctx, {
    action: 'guardrails.safetyMode.set',
    targetType: 'guardrailConfig',
    targetId: ctx.activeOrgId,
    metadata: { enabled: input.enabled },
  });
  return getConfig(ctx);
}

/** Update one rule's enabled/severity/params (partial; audited). */
export async function setRule(
  ctx: OrgContext,
  input: SetGuardrailRuleInput,
): Promise<GuardrailsConfigView> {
  const current = await getConfig(ctx);
  const rules = current.rules.map((r) =>
    r.id === input.id
      ? {
          ...r,
          enabled: input.enabled ?? r.enabled,
          severity: input.severity ?? r.severity,
          params: input.params ? { ...r.params, ...input.params } : r.params,
        }
      : r,
  );
  await ctx.db.guardrailConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { rulesJson: encodeGuardrailRules(rules) },
  });
  await writeAudit(ctx, {
    action: 'guardrails.rule.set',
    targetType: 'guardrailConfig',
    targetId: input.id,
    metadata: { ...input },
  });
  return { productionSafetyMode: current.productionSafetyMode, rules };
}

// ── Stack environments (Docker truth: the `swarmy.env` label) ─────────────────

/** Every live stack + whether it is marked production (label scan, no DB). */
export function listStackEnvs(ctx: OrgContext): StackEnvView[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const byStack = new Map<string, { production: boolean; serviceCount: number }>();
  for (const s of buildInventory(services, containers).services) {
    if (s.stack === UNGROUPED) continue;
    const entry = byStack.get(s.stack) ?? { production: false, serviceCount: 0 };
    entry.serviceCount += 1;
    if (s.labels[ENV_LABEL] === PRODUCTION_ENV) entry.production = true;
    byStack.set(s.stack, entry);
  }
  return [...byStack.entries()]
    .map(([stack, e]) => ({ stack, ...e }))
    .sort((a, b) => a.stack.localeCompare(b.stack));
}

/**
 * Mark/unmark a stack as production by stamping `swarmy.env=production` on every
 * live service in the stack (label write via `service.updateLabels`; audited).
 */
export async function setStackEnv(
  ctx: OrgContext,
  input: SetStackEnvInput,
): Promise<StackEnvView> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const members = buildInventory(services, containers).services.filter(
    (s) => s.stack === input.stack,
  );
  if (members.length === 0) throw notFound('stack', input.stack);

  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of members) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: input.production ? { [ENV_LABEL]: PRODUCTION_ENV } : {},
        removeKeys: input.production ? [] : [ENV_LABEL],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'guardrails.stackEnv.set',
    targetType: 'stack',
    targetId: input.stack,
    metadata: { production: input.production, services: members.map((s) => s.name) },
  });
  return { stack: input.stack, production: input.production, serviceCount: members.length };
}

// ── Recent decisions (AuditLog query — swarmy's queryable history) ────────────

/** Audit actions that represent an admission decision worth surfacing. */
export const DECISION_ACTIONS = [
  'guardrails.deploy.blocked',
  'stack.deploy.override',
  'service.deploy.override',
] as const;

/** Coerce an audit row's `metadata.violations` into typed violations. */
export function coerceDecisionViolations(metadata: unknown): GuardrailDecisionViolation[] {
  const meta = (typeof metadata === 'object' && metadata !== null ? metadata : {}) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(meta.violations)) return [];
  const out: GuardrailDecisionViolation[] = [];
  for (const raw of meta.violations) {
    if (typeof raw !== 'object' || raw === null) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.rule !== 'string' || typeof v.message !== 'string') continue;
    out.push({
      rule: v.rule,
      severity: v.severity === 'warn' ? 'warn' : 'block',
      message: v.message,
      ...(typeof v.resource === 'string' ? { resource: v.resource } : {}),
    });
  }
  return out;
}

/** Recent blocked/overridden admission decisions, newest first (org-scoped). */
export async function recentDecisions(
  ctx: OrgContext,
  input: GuardrailDecisionsInput,
): Promise<GuardrailDecisionView[]> {
  const rows = await ctx.db.auditLog.findMany({
    where: { orgId: ctx.activeOrgId, action: { in: [...DECISION_ACTIONS] } },
    orderBy: { ts: 'desc' },
    take: input.limit ?? 50,
    select: {
      id: true,
      action: true,
      ts: true,
      targetId: true,
      metadata: true,
      actor: { select: { name: true, email: true } },
    },
  });
  return rows.map((r) => ({
    id: String(r.id),
    at: r.ts.toISOString(),
    kind: r.action.endsWith('.override') ? ('overridden' as const) : ('blocked' as const),
    action: r.action,
    actor: r.actor?.name ?? r.actor?.email ?? null,
    stack: r.targetId ?? null,
    violations: coerceDecisionViolations(r.metadata),
  }));
}
