import {
  buildInventory,
  STACK_LABEL,
  type GuardrailRuleId,
  type GuardrailSeverity,
  type GuardrailsConfigView,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';
import { writeAudit } from './audit.service';
import { DB_BACKUP_SCHEDULE_LABEL } from './dbBackup.service';
import { DB_CLUSTER_LABEL, DB_REPLICAS_LABEL, DB_ROLE_LABEL } from './manageddb.service';
import { ENV_LABEL, PRODUCTION_ENV, readConfig } from './guardrails.service';

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
 * Refused (non-overridden) evaluations with violations are recorded to the
 * audit log (`guardrails.deploy.blocked`) — the Governance page's feed.
 */

// ── Pure: spec fact extraction ────────────────────────────────────────────────

/** The slice of a deploy spec this evaluator inspects. */
export interface GuardrailSpecFacts {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Published ports using host mode (bypass the routing mesh, bind the node). */
  hostPorts: number[];
  hasHealthcheck: boolean;
  hasMemoryLimit: boolean;
  privileged: boolean;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Coerce unknown intent specs into the facts this evaluator needs. */
export function specFacts(specs: unknown[]): GuardrailSpecFacts[] {
  const out: GuardrailSpecFacts[] = [];
  for (const raw of specs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name) continue;
    const labels =
      typeof o.labels === 'object' && o.labels !== null
        ? (o.labels as Record<string, string>)
        : {};

    const hostPorts: number[] = [];
    if (Array.isArray(o.ports)) {
      for (const p of o.ports) {
        if (typeof p !== 'object' || p === null) continue;
        const port = p as Record<string, unknown>;
        const published = num(port.published);
        if (port.mode === 'host' && published !== undefined && published > 0) {
          hostPorts.push(published);
        }
      }
    }

    const hc = (typeof o.healthcheck === 'object' && o.healthcheck !== null
      ? o.healthcheck
      : null) as { disable?: unknown; test?: unknown } | null;
    const hcTest = Array.isArray(hc?.test) ? (hc.test as unknown[]) : null;
    const hasHealthcheck =
      hc !== null && hc.disable !== true && (hcTest === null || hcTest[0] !== 'NONE');

    const resources = (typeof o.resources === 'object' && o.resources !== null
      ? o.resources
      : {}) as { limits?: { memoryBytes?: unknown } };
    const hasMemoryLimit = (num(resources.limits?.memoryBytes) ?? 0) > 0;

    const caps = [
      ...(Array.isArray(o.capAdd) ? o.capAdd : []),
      ...(Array.isArray(o.cap_add) ? o.cap_add : []),
    ];
    const privileged =
      o.privileged === true || caps.includes('ALL') || caps.includes('SYS_ADMIN');

    out.push({
      name: o.name,
      image: typeof o.image === 'string' ? o.image : '',
      labels,
      hostPorts,
      hasHealthcheck,
      hasMemoryLimit,
      privileged,
    });
  }
  return out;
}

/** True when an image ref would float on `:latest` (explicit, or no tag at all). */
export function isLatestImage(image: string): boolean {
  if (!image) return false;
  if (image.includes('@')) return false; // digest-pinned = immutable
  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon < 0) return true; // no tag → Docker pulls :latest
  return lastSegment.slice(colon + 1) === 'latest';
}

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
  if (intent.kind !== 'stack.deploy' && intent.kind !== 'service.deploy') return [];
  const specs = specFacts(intent.specs ?? []);
  if (specs.length === 0) return [];

  const config = await readConfig(ctx);

  // Prod detection: the live stack's `swarmy.env` label, or the incoming specs
  // themselves (a deploy that stamps the label counts as prod immediately).
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services;
  const prodStacks = new Set(
    live.filter((s) => s.labels[ENV_LABEL] === PRODUCTION_ENV).map((s) => s.stack),
  );
  const targetStacks = new Set<string>();
  if (intent.stackName) targetStacks.add(intent.stackName);
  for (const spec of specs) {
    const stackLabel = spec.labels[STACK_LABEL];
    if (stackLabel) targetStacks.add(stackLabel);
  }
  const isProd =
    [...targetStacks].some((s) => prodStacks.has(s)) ||
    specs.some((s) => s.labels[ENV_LABEL] === PRODUCTION_ENV);

  const rules = effectiveRules(config, isProd);
  if (rules.size === 0) return [];

  // Managed db clusters in the intent's stack(s): live facts win (Docker truth);
  // spec-only clusters (a brand-new db in this very deploy) fall back to labels.
  const clusters = new Map<string, DbClusterFact>();
  for (const spec of specs) {
    const cluster = spec.labels[DB_CLUSTER_LABEL];
    if (!cluster || clusters.has(cluster)) continue;
    clusters.set(cluster, {
      cluster,
      declaredReplicas: Number.parseInt(spec.labels[DB_REPLICAS_LABEL] ?? '', 10) || 0,
      hasBackupSchedule: !!spec.labels[DB_BACKUP_SCHEDULE_LABEL],
    });
  }
  for (const svc of live) {
    const cluster = svc.labels[DB_CLUSTER_LABEL];
    if (!cluster || !targetStacks.has(svc.stack)) continue;
    if (svc.labels[DB_ROLE_LABEL] && svc.labels[DB_ROLE_LABEL] !== 'primary') continue;
    const declared = Number.parseInt(svc.labels[DB_REPLICAS_LABEL] ?? '', 10);
    clusters.set(cluster, {
      cluster,
      declaredReplicas: Number.isFinite(declared)
        ? declared
        : live.filter(
            (m) => m.labels[DB_CLUSTER_LABEL] === cluster && m.labels[DB_ROLE_LABEL] === 'replica',
          ).length,
      hasBackupSchedule: !!svc.labels[DB_BACKUP_SCHEDULE_LABEL],
    });
  }
  const dbClusters = [...clusters.values()];

  // DB lookups only when the active rule actually needs them.
  let hasOrgBackupSchedules = false;
  if (
    rules.has('requireBackupPolicy') &&
    dbClusters.length > 0 &&
    !dbClusters.some((c) => c.hasBackupSchedule)
  ) {
    hasOrgBackupSchedules =
      (await ctx.db.backupSchedule.count({
        where: { orgId: ctx.activeOrgId, paused: false },
      })) > 0;
  }
  let signingEnforced = false;
  if (rules.has('requireSignedImagesProd')) {
    const reg = await ctx.db.registryConfig.findUnique({
      where: { orgId: ctx.activeOrgId },
      select: { requireSignedImages: true },
    });
    signingEnforced = reg?.requireSignedImages === true;
  }

  const violations = decideGuardrails({
    rules,
    isProd,
    stackName: intent.stackName,
    specs,
    estate: { dbClusters, hasOrgBackupSchedules, signingEnforced },
  });

  // A refused (non-overridden) gate is a decision worth remembering — the
  // Governance page's "recently blocked" feed reads these audit rows.
  if (violations.length > 0 && !intent.override) {
    await writeAudit(ctx, {
      action: 'guardrails.deploy.blocked',
      targetType: 'stack',
      targetId: intent.stackName,
      metadata: {
        stackName: intent.stackName ?? null,
        isProd,
        violations: violations.map((v) => ({ ...v })),
      },
    });
  }

  return violations;
}
