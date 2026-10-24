import { buildInventory, STACK_LABEL, type GuardrailRuleId, type GuardrailsConfigView } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { AdmissionIntent } from './admission.service';
import type { DbClusterFact, GuardrailEstateFacts } from './admission-guardrails';
import { specFacts, type GuardrailSpecFacts } from './admission-guardrails-specs';
import { registryConfigs } from './apps.repo';
import { backupSchedules } from './backups.repo';
import { DB_BACKUP_SCHEDULE_LABEL } from './dbBackup.service';
import { DB_CLUSTER_LABEL, DB_REPLICAS_LABEL, DB_ROLE_LABEL } from './manageddb.service';
import { ENV_LABEL, PRODUCTION_ENV, readConfig } from './guardrails.service';

/**
 * What the guardrails need to know about one admission intent, gathered once
 * and shared by the real evaluation and the "would it block?" pass: the
 * config, whether the target is production, the spec facts and the managed db
 * clusters. The two estate lookups (org backup schedules, registry signing)
 * stay lazy and memoized, so they run only when a rule asks, and at most once.
 *
 * The cache is keyed by the intent object (the gate hands the same one to
 * both passes) and lives a few seconds, so a reused intent never sees stale
 * facts.
 */
export interface GuardrailFacts {
  config: GuardrailsConfigView;
  isProd: boolean;
  specs: GuardrailSpecFacts[];
  dbClusters: DbClusterFact[];
  orgBackupSchedules: () => Promise<boolean>;
  signingEnforced: () => Promise<boolean>;
}

const MEMO_MS = 5_000;
const memo = new WeakMap<AdmissionIntent, { at: number; facts: Promise<GuardrailFacts | null> }>();

/** The intent's guardrail facts (null when no guardrail applies to it). */
export function guardrailFacts(ctx: OrgContext, intent: AdmissionIntent): Promise<GuardrailFacts | null> {
  const hit = memo.get(intent);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.facts;
  const facts = gather(ctx, intent);
  memo.set(intent, { at: Date.now(), facts });
  return facts;
}

const once = <T>(f: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

async function gather(ctx: OrgContext, intent: AdmissionIntent): Promise<GuardrailFacts | null> {
  if (intent.kind !== 'stack.deploy' && intent.kind !== 'service.deploy') return null;
  const specs = specFacts(intent.specs ?? []);
  if (specs.length === 0) return null;
  const config = await readConfig(ctx);

  // Prod detection: the live stack's `swarmy.env` label, or the incoming specs
  // themselves (a deploy that stamps the label counts as prod immediately).
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services;
  const prodStacks = new Set(live.filter((s) => s.labels[ENV_LABEL] === PRODUCTION_ENV).map((s) => s.stack));
  const targetStacks = new Set<string>();
  if (intent.stackName) targetStacks.add(intent.stackName);
  for (const spec of specs) {
    const stackLabel = spec.labels[STACK_LABEL];
    if (stackLabel) targetStacks.add(stackLabel);
  }
  const isProd =
    [...targetStacks].some((s) => prodStacks.has(s)) || specs.some((s) => s.labels[ENV_LABEL] === PRODUCTION_ENV);

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
        : live.filter((m) => m.labels[DB_CLUSTER_LABEL] === cluster && m.labels[DB_ROLE_LABEL] === 'replica').length,
      hasBackupSchedule: !!svc.labels[DB_BACKUP_SCHEDULE_LABEL],
    });
  }

  return {
    config,
    isProd,
    specs,
    dbClusters: [...clusters.values()],
    orgBackupSchedules: once(
      async () =>
        (await backupSchedules(ctx, ctx.activeOrgId).count({ where: { orgId: ctx.activeOrgId, paused: false } })) > 0,
    ),
    signingEnforced: once(async () => {
      const reg = await registryConfigs(ctx, ctx.activeOrgId).findUnique({
        where: { orgId: ctx.activeOrgId },
        select: { requireSignedImages: true },
      });
      return reg?.requireSignedImages === true;
    }),
  };
}

/** The estate facts these rules need: a lookup runs only when one of them asks. */
export async function estateFor(
  facts: GuardrailFacts,
  rules: ReadonlySet<GuardrailRuleId>,
): Promise<GuardrailEstateFacts> {
  const { dbClusters } = facts;
  const needsBackups =
    rules.has('requireBackupPolicy') && dbClusters.length > 0 && !dbClusters.some((c) => c.hasBackupSchedule);
  return {
    dbClusters,
    hasOrgBackupSchedules: needsBackups ? await facts.orgBackupSchedules() : false,
    signingEnforced: rules.has('requireSignedImagesProd') ? await facts.signingEnforced() : false,
  };
}
