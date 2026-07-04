/**
 * Resilience (slice F2) — posture checks, readiness score, and safe drills.
 *
 * The audit is a pure pass over a snapshot of live signals: Docker-truth labels
 * (`swarmy.db.*`, `swarmy.cache.*`, `swarmy.env`), the hub's node inventory,
 * the org's backup rows and the geo/ingress/controller-backup configs. Each
 * finding carries a severity and a fix link; score = 100 − Σ weights
 * (crit 15, warn 7, info 2, floored at 0) → grade + "Production readiness: NN%".
 *
 * Drills are admin-only, confirmed in the UI, and audited. Outcomes are NOT a
 * new model: each run writes one `resilience.drill` audit row whose metadata IS
 * the `ResilienceDrillResultView`; "last tested" reads those rows back (plus a
 * small in-memory cache so a lost audit write never blanks the page mid-session).
 *  - restore: clone the latest logical DB backup into a throwaway
 *    `drill-<ts>` cluster, verify `SELECT 1`, destroy the clone.
 *  - failover: promote a standby (`pg_promote()`), verify it left recovery,
 *    then force-restart the replica service so it rejoins the chain.
 *  - backup-verify: `restic check` on the backup destination via
 *    `container.runOnce` (mirrors the agent backup handler's env contract).
 */
import {
  buildInventory,
  type InvService,
  type ResilienceBackupVerifyInput,
  type ResilienceCheckId,
  type ResilienceDrillCardView,
  type ResilienceDrillKind,
  type ResilienceDrillResultView,
  type ResilienceDrillStepView,
  type ResilienceDrillTargetView,
  type ResilienceFailoverDrillInput,
  type ResilienceGrade,
  type ResilienceOverviewView,
  type ResilienceProblemView,
  type ResilienceRestoreDrillInput,
  type ResilienceScoreView,
  type ResilienceSeverity,
} from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import { DEFAULT_RESTIC_IMAGE, type RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import {
  DB_BACKUP_LAST_RUN_LABEL,
  listDbBackups,
  parseLastRunLabel,
  restoreDb,
} from './dbBackup.service';
import { getConfig as getGeoDnsConfig } from './geodns.service';
import { collectGeoEndpoints } from './dns-snapshot.service';
import { getConfig as getIngressConfig } from './ingress.service';
import {
  DB_CLUSTER_LABEL,
  DB_MEMBER_LABEL,
  DB_REPLICAS_LABEL,
  DB_ROLE_LABEL,
  DB_TOPOLOGY_LABEL,
  DEFAULT_TOPOLOGY,
  primaryServiceName,
  provisionDb,
  replicaServiceName,
  clusterNetworkName,
} from './manageddb.service';
import { resolveExecTarget } from './live-resolve';
import { getConfig as getControllerBackupConfig } from './controllerBackup.service';
import { getConfig as getStorageConfig } from './replicatedStore.service';
import { resticNetworkFor } from './backups.service';

// ── Read-only label mirrors (A3/E4 schemes; canonical copies live with owners) ─
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_TOPOLOGY_LABEL = 'swarmy.cache.topology';
const MANAGED_LABEL = 'swarmy.managed';
const ENV_LABEL = 'swarmy.env';
const MANAGED_DATA_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];

/** Every drill outcome persists as one audit row with this action. */
export const DRILL_AUDIT_ACTION = 'resilience.drill';

export const SEVERITY_WEIGHT: Record<ResilienceSeverity, number> = {
  crit: 15,
  warn: 7,
  info: 2,
};

/** "No successful backup in N days" / "controller backup stale" threshold. */
export const BACKUP_STALE_DAYS = 7;
const DAY_MS = 86_400_000;
const CHECKS_RUN = 9;

// ── Pure snapshot shape (fixture-friendly — the classifiers never touch ctx) ──

export interface ResilienceServiceSignal {
  name: string;
  stack: string;
  mode: 'replicated' | 'global';
  desired: number;
  running: number;
  scaleToZero: boolean;
  labels: Record<string, string>;
}

export interface ResilienceSnapshot {
  /** ISO "now" the checks evaluate against. */
  now: string;
  services: ResilienceServiceSignal[];
  /** Distinct `swarmy.region` node-label values across the estate. */
  estateRegions: string[];
  ingress: { enabled: boolean; instanceCount: number };
  /** Replicated object store (Garage) config; null when never configured. */
  storage: { enabled: boolean; replicationFactor: number } | null;
  backups: {
    /** Enabled backup destinations. */
    targetCount: number;
    /** Latest successful backup of any kind (volume restic / DB run), ISO. */
    lastSuccessAt: string | null;
  };
  geodns: { enabled: boolean; recordRegions: string[] };
  controllerBackup: { enabled: boolean; lastRunAt: string | null };
  /** Last successful restore drill (read back from the audit log), ISO. */
  lastRestoreDrillAt: string | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function managedDataService(labels: Record<string, string>): boolean {
  for (const key of Object.keys(labels)) {
    for (const prefix of MANAGED_DATA_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** A user-owned app: replicated, not swarmy-managed, not a managed data member. */
export function isUserService(s: ResilienceServiceSignal): boolean {
  if (s.mode !== 'replicated') return false;
  if (s.scaleToZero) return false;
  if (s.name.startsWith('swarmy-')) return false;
  if (s.labels[MANAGED_LABEL] === 'true') return false;
  if (managedDataService(s.labels)) return false;
  return true;
}

/** Whether any service in the stack marks it production (`swarmy.env`). */
export function stackIsProduction(services: ResilienceServiceSignal[], stack: string): boolean {
  return services.some((s) => s.stack === stack && s.labels[ENV_LABEL] === 'production');
}

function olderThan(iso: string | null, days: number, now: Date): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > days * DAY_MS;
}

function problem(
  check: ResilienceCheckId,
  severity: ResilienceSeverity,
  fields: Omit<ResilienceProblemView, 'id' | 'check' | 'severity'>,
  idSuffix = '',
): ResilienceProblemView {
  return { id: idSuffix ? `${check}/${idSuffix}` : check, check, severity, ...fields };
}

// ── Pure: the check classifiers ────────────────────────────────────────────────

export function runChecks(snap: ResilienceSnapshot): ResilienceProblemView[] {
  const now = new Date(snap.now);
  const out: ResilienceProblemView[] = [];

  // 1. Single-replica user services (one aggregated warn).
  const singles = snap.services.filter((s) => isUserService(s) && s.desired === 1);
  if (singles.length > 0) {
    const names = singles.map((s) => s.name).sort();
    const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4}` : '');
    out.push(
      problem('single-replica', 'warn', {
        title: `${names.length} service${names.length === 1 ? ' runs' : 's run'} a single replica`,
        detail: `${shown} — one task means one crash or one node loss takes ${names.length === 1 ? 'it' : 'them'} offline.`,
        fixHint: 'Scale to 2+ replicas so the scheduler can reschedule around failures.',
        fixPath: '/services',
        fixLabel: 'Scale the service',
        resource: shown,
      }),
    );
  }

  // 2. Managed cache with no replica (per cluster).
  for (const s of snap.services) {
    if (s.labels[CACHE_ROLE_LABEL] !== 'primary') continue;
    const topology = s.labels[CACHE_TOPOLOGY_LABEL] ?? 'single';
    if (topology !== 'single') continue;
    const cluster = s.labels[CACHE_CLUSTER_LABEL] ?? s.name;
    const ref = `${s.stack}/${cluster}`;
    out.push(
      problem(
        'cache-no-replica',
        'warn',
        {
          title: `Cache ${ref} has no replica`,
          detail: 'A single-node cache loses every key (and every session) when its task dies.',
          fixHint: 'Switch the cluster to replica or sentinel topology on the Data page.',
          fixPath: '/data/cache',
          fixLabel: 'Add a replica',
          resource: ref,
        },
        ref,
      ),
    );
  }

  // 3. DB topology risk (crit in production, info elsewhere).
  const anchors = snap.services.filter(
    (s) =>
      Boolean(s.labels[DB_CLUSTER_LABEL]) &&
      s.labels[DB_ROLE_LABEL] === 'primary' &&
      !s.labels[DB_MEMBER_LABEL],
  );
  for (const a of anchors) {
    const topology = a.labels[DB_TOPOLOGY_LABEL] ?? DEFAULT_TOPOLOGY;
    const declared = Number.parseInt(a.labels[DB_REPLICAS_LABEL] ?? '0', 10) || 0;
    if (topology !== 'single' && declared > 0) continue;
    const cluster = a.labels[DB_CLUSTER_LABEL]!;
    const ref = `${a.stack}/${cluster}`;
    const prod = stackIsProduction(snap.services, a.stack);
    out.push(
      problem(
        'db-topology',
        prod ? 'crit' : 'info',
        {
          title: prod
            ? `Production database ${ref} has no standby`
            : `Database ${ref} has no standby`,
          detail:
            topology === 'single'
              ? `Topology is "single" — one copy of the data, no failover${prod ? ' in production' : ''}.`
              : 'No read replicas are declared — the primary is the only copy.',
          fixHint: 'Move the cluster to primary-replica (or failover) topology with ≥1 replica.',
          fixPath: '/data',
          fixLabel: 'Change topology',
          resource: ref,
        },
        ref,
      ),
    );
  }

  // 4. Object-store replication factor.
  if (snap.storage?.enabled && snap.storage.replicationFactor < 3) {
    out.push(
      problem('storage-replication', 'warn', {
        title: `Object storage replicates ${snap.storage.replicationFactor}×`,
        detail: `Garage keeps ${snap.storage.replicationFactor} cop${snap.storage.replicationFactor === 1 ? 'y' : 'ies'} of each object — below the 3 needed to survive a node loss during a rebalance.`,
        fixHint: 'Raise the replication factor to 3 and add member nodes to match.',
        fixPath: '/backups',
        fixLabel: 'Raise replication',
        resource: 'swarmy-garage',
      }),
    );
  }

  // 5. Backup recency (only meaningful once something is running).
  if (snap.services.length > 0) {
    if (snap.backups.targetCount === 0) {
      out.push(
        problem('backup-recency', 'crit', {
          title: 'No backup destination configured',
          detail: 'Nothing is being backed up — a disk loss is a data loss.',
          fixHint: 'Add an S3 or node-path backup destination, then schedule backups.',
          fixPath: '/backups',
          fixLabel: 'Add a destination',
          resource: null,
        }),
      );
    } else if (olderThan(snap.backups.lastSuccessAt, BACKUP_STALE_DAYS, now)) {
      out.push(
        problem('backup-recency', 'crit', {
          title: snap.backups.lastSuccessAt
            ? `No successful backup in ${BACKUP_STALE_DAYS} days`
            : 'No successful backup yet',
          detail: snap.backups.lastSuccessAt
            ? `The newest good backup is from ${snap.backups.lastSuccessAt.slice(0, 10)} — your recovery point is drifting.`
            : 'A destination exists but no backup has ever succeeded.',
          fixHint: 'Run a backup now and check the schedule on the Backups page.',
          fixPath: '/backups',
          fixLabel: 'Run a backup',
          resource: null,
        }),
      );
    }
  }

  // 6. Restore never tested (backups exist but were never proven restorable).
  if (snap.backups.lastSuccessAt && !snap.lastRestoreDrillAt) {
    out.push(
      problem('restore-untested', 'warn', {
        title: 'Backups exist but a restore was never tested',
        detail: 'An unrestored backup is a hope, not a plan.',
        fixHint: 'Run the restore drill — it clones the latest backup into a throwaway cluster and verifies it.',
        fixPath: '/resilience',
        fixLabel: 'Run the restore drill',
        resource: null,
      }),
    );
  }

  // 7. Ingress on a single node.
  if (snap.ingress.enabled && snap.ingress.instanceCount <= 1) {
    out.push(
      problem('ingress-single', 'warn', {
        title: 'Ingress runs on a single node',
        detail: 'Every domain goes dark if that one edge node goes down.',
        fixHint: 'Label a second node `swarmy.node.ingress=true` so the edge survives a node loss.',
        fixPath: '/ingress',
        fixLabel: 'Add an edge node',
        resource: null,
      }),
    );
  }

  // 8. Geo-DNS single region on a multi-region estate.
  if (snap.estateRegions.length >= 2) {
    const regions = new Set(snap.geodns.recordRegions);
    if (!snap.geodns.enabled || regions.size <= 1) {
      out.push(
        problem('geodns-single-region', 'info', {
          title: `Geo-DNS ${snap.geodns.enabled ? 'answers from one region' : 'is off'} on a ${snap.estateRegions.length}-region estate`,
          detail: `Your nodes span ${snap.estateRegions.sort().join(', ')} but DNS ${snap.geodns.enabled ? 'steers to a single region' : 'does no regional steering'} — a region loss still takes traffic down.`,
          fixHint: 'Add Geo-DNS records for each region so DNS fails over by omission.',
          fixPath: '/geo/dns',
          fixLabel: 'Add regional records',
          resource: null,
        }),
      );
    }
  }

  // 9. Controller backup recency (the platform's own brain).
  if (!snap.controllerBackup.enabled && !snap.controllerBackup.lastRunAt) {
    out.push(
      problem('controller-backup', 'warn', {
        title: 'Controller backups are off',
        detail: "swarmy's own state (orgs, nodes, audit, settings) has no recovery bundle.",
        fixHint: 'Enable controller backups with a restore passphrase in Settings → Backup.',
        fixPath: '/settings/backup',
        fixLabel: 'Enable controller backups',
        resource: null,
      }),
    );
  } else if (olderThan(snap.controllerBackup.lastRunAt, BACKUP_STALE_DAYS, now)) {
    out.push(
      problem('controller-backup', 'warn', {
        title: `Controller backup older than ${BACKUP_STALE_DAYS} days`,
        detail: 'The recovery bundle for the control plane is stale.',
        fixHint: 'Run a controller backup now and check its schedule.',
        fixPath: '/settings/backup',
        fixLabel: 'Run controller backup',
        resource: null,
      }),
    );
  }

  const order: Record<ResilienceSeverity, number> = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
}

// ── Pure: score math ───────────────────────────────────────────────────────────

export function gradeFor(score: number): ResilienceGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

export function scoreProblems(
  problems: ResilienceProblemView[],
  generatedAt: Date,
): ResilienceScoreView {
  const counts = { crit: 0, warn: 0, info: 0 };
  let penalty = 0;
  for (const p of problems) {
    counts[p.severity] += 1;
    penalty += SEVERITY_WEIGHT[p.severity];
  }
  const score = Math.max(0, 100 - penalty);
  return {
    score,
    grade: gradeFor(score),
    headline: `Production readiness: ${score}%`,
    counts,
    checksRun: CHECKS_RUN,
    problems,
    generatedAt: generatedAt.toISOString(),
  };
}

// ── Pure: restic-check env (mirrors the agent backup handler's contract) ──────

export interface ResticRepoEnvInput {
  repo: string;
  password: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

export function buildResticCheckEnv(input: ResticRepoEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: input.repo,
    RESTIC_PASSWORD: input.password,
  };
  if (input.accessKeyId) env.AWS_ACCESS_KEY_ID = input.accessKeyId;
  if (input.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = input.secretAccessKey;
  if (input.region) env.AWS_DEFAULT_REGION = input.region;
  return env;
}

/** restic repo URL from a backup-target row (same scheme as backups.service). */
export function resticRepoUrl(
  kind: string,
  endpoint: string | null,
  bucket: string,
  prefix: string | null,
): string {
  const pfx = prefix ? `/${prefix.replace(/^\/+/, '')}` : '';
  if (kind === 'node' || kind === 'NODE') return `${bucket.replace(/\/+$/, '')}${pfx}`;
  return `s3:${(endpoint ?? '').replace(/\/+$/, '')}/${bucket}${pfx}`;
}

// ── Snapshot gathering (live signals → the pure shape) ───────────────────────

function liveServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function toSignal(s: InvService): ResilienceServiceSignal {
  return {
    name: s.name,
    stack: s.stack,
    mode: s.mode,
    desired: s.replicas.desired,
    running: s.replicas.running,
    scaleToZero: s.scaleToZero,
    labels: s.labels,
  };
}

/** Latest successful backup across volume snapshots + per-cluster DB runs. */
function latestBackupAt(
  ctx: OrgContext,
  services: InvService[],
  stack?: string,
): Promise<string | null> {
  const dbTimes = services
    .filter((s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL])
    .map((s) => parseLastRunLabel(s.labels[DB_BACKUP_LAST_RUN_LABEL]))
    .filter((r): r is NonNullable<typeof r> => r != null && r.status === 'succeeded')
    .map((r) => r.at);
  return ctx.db.snapshot
    .findFirst({
      where: {
        orgId: ctx.activeOrgId,
        status: 'SUCCEEDED',
        // Volumes belong to a stack by name prefix (`<stack>_<volume>`).
        ...(stack ? { volume: { startsWith: `${stack}_` } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    .then((row) => {
      const times = [...dbTimes, ...(row ? [row.startedAt.toISOString()] : [])];
      if (times.length === 0) return null;
      return times.sort().at(-1) ?? null;
    })
    .catch(() => (dbTimes.length ? (dbTimes.sort().at(-1) ?? null) : null));
}

export async function buildSnapshot(ctx: OrgContext, stack?: string): Promise<ResilienceSnapshot> {
  // Stack scope narrows the service signals + backup recency to one stack;
  // estate-level posture (ingress, geo, controller backups) stays shared.
  const inv = liveServices(ctx).filter((s) => !stack || s.stack === stack);
  const regions = [...ctx.hub.nodesByRegion(ctx.activeOrgId).keys()];

  const [ingress, storage, geoCfg, geoRecords, controller, targetCount, lastSuccessAt, drills] =
    await Promise.all([
      getIngressConfig(ctx).catch(() => null),
      getStorageConfig(ctx).catch(() => null),
      getGeoDnsConfig(ctx).catch(() => null),
      Promise.resolve().then(() => collectGeoEndpoints(ctx)).catch(() => []),
      getControllerBackupConfig(ctx.db).catch(() => null),
      ctx.db.backupTarget.count({ where: { orgId: ctx.activeOrgId, enabled: true } }).catch(() => 0),
      latestBackupAt(ctx, inv, stack),
      listDrillHistory(ctx, 50, stack),
    ]);

  const lastRestore = drills.find((d) => d.kind === 'restore' && d.status === 'passed');

  return {
    now: new Date().toISOString(),
    services: inv.map(toSignal),
    estateRegions: regions,
    ingress: {
      enabled: Boolean(ingress && ingress.enabled && ingress.driver !== 'none'),
      instanceCount:
        ingress && ingress.enabled && ingress.driver !== 'none'
          ? Math.max(ingress.targetNodes.length, 1)
          : 0,
    },
    storage: storage
      ? { enabled: storage.enabled, replicationFactor: storage.replicationFactor }
      : null,
    backups: { targetCount, lastSuccessAt },
    geodns: {
      enabled: Boolean(geoCfg?.enabled),
      recordRegions: [...new Set(geoRecords.map((r) => r.region))],
    },
    controllerBackup: {
      enabled: Boolean(controller?.enabled),
      lastRunAt: controller?.lastRunAt ?? null,
    },
    lastRestoreDrillAt: lastRestore?.at ?? null,
  };
}

// ── Drill history (audit rows are the store; memory covers lost writes) ───────

const recentDrills = new Map<string, ResilienceDrillResultView[]>();

function parseDrillMetadata(meta: unknown): ResilienceDrillResultView | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const m = meta as Partial<ResilienceDrillResultView>;
  if (m.kind !== 'restore' && m.kind !== 'failover' && m.kind !== 'backup-verify') return null;
  if (m.status !== 'passed' && m.status !== 'failed') return null;
  if (typeof m.at !== 'string') return null;
  return {
    kind: m.kind,
    status: m.status,
    at: m.at,
    durationMs: typeof m.durationMs === 'number' ? m.durationMs : 0,
    target: typeof m.target === 'string' ? m.target : null,
    summary: typeof m.summary === 'string' ? m.summary : '',
    steps: Array.isArray(m.steps) ? (m.steps as ResilienceDrillStepView[]) : [],
    error: typeof m.error === 'string' ? m.error : null,
  };
}

export async function listDrillHistory(
  ctx: OrgContext,
  limit = 20,
  stack?: string,
): Promise<ResilienceDrillResultView[]> {
  let persisted: ResilienceDrillResultView[] = [];
  try {
    const rows = await ctx.db.auditLog.findMany({
      where: { orgId: ctx.activeOrgId, action: DRILL_AUDIT_ACTION },
      orderBy: { ts: 'desc' },
      take: limit,
      select: { metadata: true },
    });
    persisted = rows
      .map((r) => parseDrillMetadata(r.metadata))
      .filter((r): r is ResilienceDrillResultView => r != null);
  } catch {
    persisted = [];
  }
  const seen = new Set(persisted.map((r) => `${r.kind}@${r.at}`));
  const memory = (recentDrills.get(ctx.activeOrgId) ?? []).filter(
    (r) => !seen.has(`${r.kind}@${r.at}`),
  );
  return [...memory, ...persisted]
    // Restore/failover drill targets are `<stack>/<cluster>` refs.
    .filter((r) => !stack || (r.target ?? '').startsWith(`${stack}/`))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

async function recordDrill(
  ctx: OrgContext,
  result: ResilienceDrillResultView,
): Promise<ResilienceDrillResultView> {
  const list = recentDrills.get(ctx.activeOrgId) ?? [];
  recentDrills.set(ctx.activeOrgId, [result, ...list].slice(0, 20));
  await writeAudit(ctx, {
    action: DRILL_AUDIT_ACTION,
    targetType: 'resilienceDrill',
    targetId: result.target ? `${result.kind}:${result.target}` : result.kind,
    metadata: result as unknown as Record<string, unknown>,
  });
  return result;
}

// ── Overview ──────────────────────────────────────────────────────────────────

function drillTargets(services: InvService[]): ResilienceDrillTargetView[] {
  return services
    .filter(
      (s) =>
        Boolean(s.labels[DB_CLUSTER_LABEL]) &&
        s.labels[DB_ROLE_LABEL] === 'primary' &&
        !s.labels[DB_MEMBER_LABEL],
    )
    .map((p) => {
      const stack = p.stack;
      const cluster = p.labels[DB_CLUSTER_LABEL]!;
      const replica = services.find(
        (s) =>
          s.stack === stack &&
          s.labels[DB_CLUSTER_LABEL] === cluster &&
          s.labels[DB_ROLE_LABEL] === 'replica',
      );
      return {
        stack,
        cluster,
        topology: p.labels[DB_TOPOLOGY_LABEL] ?? DEFAULT_TOPOLOGY,
        healthy: p.status === 'running',
        replicasRunning: replica?.replicas.running ?? 0,
      };
    })
    .sort((a, b) => `${a.stack}/${a.cluster}`.localeCompare(`${b.stack}/${b.cluster}`));
}

export function buildDrillCards(
  snap: ResilienceSnapshot,
  targets: ResilienceDrillTargetView[],
  history: ResilienceDrillResultView[],
): ResilienceDrillCardView[] {
  const last = (kind: ResilienceDrillKind): ResilienceDrillResultView | null =>
    history.find((h) => h.kind === kind) ?? null;
  const lastPassedRestore = history.find((h) => h.kind === 'restore' && h.status === 'passed');
  const rpoSeconds = snap.backups.lastSuccessAt
    ? Math.max(
        0,
        Math.round((new Date(snap.now).getTime() - new Date(snap.backups.lastSuccessAt).getTime()) / 1000),
      )
    : null;
  const failoverReady = targets.some(
    (t) =>
      (t.topology === 'failover' || t.topology === 'primary-replica') &&
      t.healthy &&
      t.replicasRunning >= 1,
  );

  return [
    {
      kind: 'restore',
      available: targets.length > 0 && snap.backups.targetCount > 0,
      unavailableReason:
        targets.length === 0
          ? 'Needs a managed DB cluster.'
          : snap.backups.targetCount === 0
            ? 'Needs a backup destination.'
            : null,
      last: last('restore'),
      rpoSeconds,
      rtoEstimateMs: lastPassedRestore?.durationMs ?? null,
    },
    {
      kind: 'failover',
      available: failoverReady,
      unavailableReason: failoverReady
        ? null
        : 'Needs a healthy failover or primary-replica cluster with a running replica.',
      last: last('failover'),
      rpoSeconds: null,
      rtoEstimateMs: null,
    },
    {
      kind: 'backup-verify',
      available: snap.backups.targetCount > 0,
      unavailableReason: snap.backups.targetCount > 0 ? null : 'Needs a backup destination.',
      last: last('backup-verify'),
      rpoSeconds: null,
      rtoEstimateMs: null,
    },
  ];
}

export async function overview(
  ctx: OrgContext,
  input?: { stack?: string },
): Promise<ResilienceOverviewView> {
  const stack = input?.stack;
  const snap = await buildSnapshot(ctx, stack);
  const problems = runChecks(snap);
  const targets = drillTargets(liveServices(ctx)).filter((t) => !stack || t.stack === stack);
  const history = await listDrillHistory(ctx, 20, stack);
  return {
    ready: true,
    score: scoreProblems(problems, new Date(snap.now)),
    drills: buildDrillCards(snap, targets, history),
    drillTargets: targets,
  };
}

// ── Drill plumbing ────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const EXEC_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 3_000;

interface StepRecorder {
  steps: ResilienceDrillStepView[];
  run<T>(name: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T>;
}

function stepRecorder(): StepRecorder {
  const steps: ResilienceDrillStepView[] = [];
  return {
    steps,
    async run<T>(name: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T> {
      const t0 = Date.now();
      try {
        const v = await fn();
        steps.push({
          name,
          status: 'passed',
          detail: detail ? detail(v) : null,
          durationMs: Date.now() - t0,
        });
        return v;
      } catch (e) {
        steps.push({
          name,
          status: 'failed',
          detail: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - t0,
        });
        throw e;
      }
    },
  };
}

/** Run `sh -c <script>` inside a service's running container (org-scoped). */
async function execInService(ctx: OrgContext, service: string, script: string): Promise<string> {
  const target = resolveExecTarget(ctx, service);
  if (!target) throw commandRejected(`service "${service}" has no running container`);
  const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
    target.nodeId,
    'exec',
    {
      target: { containerId: target.containerId },
      cmd: ['sh', '-c', script],
      tty: false,
      stream: false,
    },
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (res.exitCode !== 0) {
    throw commandRejected(`exec exited ${res.exitCode}: ${(res.output ?? '').slice(0, 200)}`);
  }
  return (res.output ?? '').trim();
}

/** psql one-liner against localhost inside a bitnami postgres container. */
function psqlScript(sql: string): string {
  return `PGPASSWORD="$POSTGRESQL_PASSWORD" psql -U postgres -h 127.0.0.1 -p 5432 -tAc "${sql}"`;
}

async function waitForPostgres(ctx: OrgContext, service: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'timed out';
  while (Date.now() < deadline) {
    try {
      const out = await execInService(ctx, service, 'pg_isready -h 127.0.0.1 -p 5432');
      if (out.includes('accepting connections')) return;
      lastError = out;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(READY_POLL_MS);
  }
  throw commandRejected(`postgres in "${service}" never became ready: ${lastError}`);
}

function finishDrill(
  ctx: OrgContext,
  base: { kind: ResilienceDrillKind; target: string | null; startedAt: number },
  rec: StepRecorder,
  outcome: { status: 'passed' | 'failed'; summary: string; error?: string },
): Promise<ResilienceDrillResultView> {
  return recordDrill(ctx, {
    kind: base.kind,
    status: outcome.status,
    at: new Date().toISOString(),
    durationMs: Date.now() - base.startedAt,
    target: base.target,
    summary: outcome.summary,
    steps: rec.steps,
    error: outcome.error ?? null,
  });
}

// ── Drill 1: restore (clone → verify → destroy) ───────────────────────────────

export async function runRestoreDrill(
  ctx: OrgContext,
  input: ResilienceRestoreDrillInput,
): Promise<ResilienceDrillResultView> {
  const target = `${input.stack}/${input.cluster}`;

  // Preconditions throw (nothing was touched yet — not a drill outcome).
  const snapshots = await listDbBackups(ctx, { stack: input.stack, cluster: input.cluster });
  const latest = snapshots[0];
  if (!latest) {
    throw commandRejected(`no backups found for ${target} — run a DB backup first`);
  }
  const engine =
    latest.engine === 'snapshot-from-replica' ? 'pg_dump' : (latest.engine ?? 'pg_dump');
  if (engine === 'wal-g' || engine === 'pgbackrest') {
    throw commandRejected('the restore drill supports logical backups (pg_dump/pg_dumpall) only');
  }

  const startedAt = Date.now();
  const rec = stepRecorder();
  const drillCluster = `drill-${Date.now().toString(36)}`;
  const drillPrimary = primaryServiceName(input.stack, drillCluster);
  const drillReplica = replicaServiceName(input.stack, drillCluster);
  const node = await resolveManagerNode(ctx);

  const cleanup = async (): Promise<void> => {
    for (const service of [drillPrimary, drillReplica]) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service }).catch(() => undefined);
    }
  };

  try {
    await rec.run('Create throwaway cluster', async () => {
      try {
        await ctx.hub.dispatch(node.id, 'network.ensure', {
          name: clusterNetworkName(input.stack, drillCluster),
        });
      } catch (e) {
        throw mapDispatchError(e);
      }
      await provisionDb(ctx, { stack: input.stack, name: drillCluster, replicas: 0 });
      return drillCluster;
    }, (c) => `deployed ${input.stack}_${c}-primary`);

    await rec.run('Wait for postgres', () => waitForPostgres(ctx, drillPrimary));

    await rec.run(
      `Restore snapshot ${latest.id.slice(0, 8)}`,
      () =>
        restoreDb(ctx, {
          stack: input.stack,
          cluster: input.cluster,
          engine,
          mode: 'clone-to-new-cluster',
          snapshotId: latest.id,
          targetStack: input.stack,
          targetCluster: drillCluster,
        }),
      (r) => `${r.bytesRestored} bytes restored`,
    );

    await rec.run('Verify SELECT 1', async () => {
      const out = await execInService(ctx, drillPrimary, psqlScript('SELECT 1'));
      if (!out.split('\n').some((l) => l.trim() === '1')) {
        throw commandRejected(`unexpected SELECT 1 output: "${out.slice(0, 80)}"`);
      }
    });

    await rec.run('Destroy the clone', cleanup);

    return await finishDrill(ctx, { kind: 'restore', target, startedAt }, rec, {
      status: 'passed',
      summary: `Restored ${latest.id.slice(0, 8)} into ${drillCluster}, verified SELECT 1, destroyed the clone.`,
    });
  } catch (e) {
    await cleanup();
    return await finishDrill(ctx, { kind: 'restore', target, startedAt }, rec, {
      status: 'failed',
      summary: `Restore drill against ${target} failed.`,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Drill 2: failover (promote a standby, verify, rejoin) ─────────────────────

export async function runFailoverDrill(
  ctx: OrgContext,
  input: ResilienceFailoverDrillInput,
): Promise<ResilienceDrillResultView> {
  const target = `${input.stack}/${input.cluster}`;
  const services = liveServices(ctx);
  const members = services.filter(
    (s) => s.stack === input.stack && s.labels[DB_CLUSTER_LABEL] === input.cluster,
  );
  const primary = members.find(
    (s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL],
  );
  if (!primary) throw notFound('db cluster', target);
  const topology = primary.labels[DB_TOPOLOGY_LABEL] ?? DEFAULT_TOPOLOGY;
  if (topology !== 'failover' && topology !== 'primary-replica') {
    throw commandRejected(
      `failover drills need a failover or primary-replica topology (cluster is "${topology}")`,
    );
  }
  const replica = members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica');
  // Safety gate: only drill a fully healthy cluster.
  if (primary.status !== 'running' || !replica || replica.replicas.running < 1) {
    throw commandRejected(
      'the cluster must be fully healthy (primary running + ≥1 running replica) to drill failover',
    );
  }

  const startedAt = Date.now();
  const rec = stepRecorder();
  const node = await resolveManagerNode(ctx);

  try {
    await rec.run('Confirm standby is replicating', async () => {
      const out = await execInService(ctx, replica.name, psqlScript('SELECT pg_is_in_recovery()'));
      if (!out.includes('t')) throw commandRejected('the replica is not in recovery');
    });

    await rec.run('Promote the standby', async () => {
      const out = await execInService(ctx, replica.name, psqlScript('SELECT pg_promote(true, 60)'));
      if (!out.includes('t')) throw commandRejected(`pg_promote did not confirm: "${out.slice(0, 80)}"`);
    });

    await rec.run('Verify it accepts writes', async () => {
      const out = await execInService(ctx, replica.name, psqlScript('SELECT pg_is_in_recovery()'));
      if (!out.includes('f')) throw commandRejected('the promoted standby is still in recovery');
    });

    await rec.run('Rejoin as replica', async () => {
      try {
        await ctx.hub.dispatch(node.id, 'service.restart', {
          service: replica.name,
          forceNewTask: true,
        });
      } catch (e) {
        throw mapDispatchError(e);
      }
    });

    return await finishDrill(ctx, { kind: 'failover', target, startedAt }, rec, {
      status: 'passed',
      summary: `Promoted a ${target} standby, verified it left recovery, rejoined it to the chain.`,
    });
  } catch (e) {
    // Best-effort: force the replica back through its entrypoint regardless.
    await ctx.hub
      .dispatch(node.id, 'service.restart', { service: replica.name, forceNewTask: true })
      .catch(() => undefined);
    return await finishDrill(ctx, { kind: 'failover', target, startedAt }, rec, {
      status: 'failed',
      summary: `Failover drill against ${target} failed.`,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Drill 3: backup-verify (restic check via container.runOnce) ───────────────

interface BackupTargetRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
}

export async function runBackupVerify(
  ctx: OrgContext,
  input: ResilienceBackupVerifyInput,
): Promise<ResilienceDrillResultView> {
  const row = (await ctx.db.backupTarget.findFirst({
    where: input.targetId
      ? { id: input.targetId, orgId: ctx.activeOrgId }
      : { orgId: ctx.activeOrgId, enabled: true },
    orderBy: { createdAt: 'asc' },
  })) as unknown as BackupTargetRow | null;
  if (!row) throw notFound('backup target', input.targetId);

  const startedAt = Date.now();
  const rec = stepRecorder();
  const isNode = row.kind === 'node' || row.kind === 'NODE';
  const repo = resticRepoUrl(row.kind, row.endpoint, row.bucket, row.prefix);
  // In-cluster targets (swarmy-garage) only resolve on the swarmy overlay.
  const network = isNode ? undefined : resticNetworkFor(row.endpoint);
  const env = buildResticCheckEnv({
    repo,
    password: decryptSecret(row.resticPasswordRef),
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
    region: row.region ?? undefined,
  });

  try {
    const res = await rec.run(
      `restic check on "${row.name}"`,
      async () => {
        const node = await resolveManagerNode(ctx);
        try {
          return await ctx.hub.dispatch<RunOnceResult>(
            node.id,
            'container.runOnce',
            {
              image: DEFAULT_RESTIC_IMAGE,
              cmd: ['check'],
              env,
              binds: isNode ? [`${repo}:${repo}`] : [],
              ...(network ? { networks: [network] } : {}),
              pull: true,
              timeoutMs: 180_000,
            },
            { timeoutMs: 200_000 },
          );
        } catch (e) {
          throw mapDispatchError(e);
        }
      },
      (r) => `exit ${r.exitCode}`,
    );

    const tail = res.output.trim().split('\n').slice(-3).join(' · ').slice(0, 240);
    if (res.exitCode !== 0) {
      return await finishDrill(ctx, { kind: 'backup-verify', target: row.name, startedAt }, rec, {
        status: 'failed',
        summary: `restic check on "${row.name}" found problems.`,
        error: tail || `restic check exited ${res.exitCode}`,
      });
    }
    return await finishDrill(ctx, { kind: 'backup-verify', target: row.name, startedAt }, rec, {
      status: 'passed',
      summary: `restic check on "${row.name}" passed — ${tail || 'no errors were found'}.`,
    });
  } catch (e) {
    return await finishDrill(ctx, { kind: 'backup-verify', target: row.name, startedAt }, rec, {
      status: 'failed',
      summary: `Backup verification on "${row.name}" failed.`,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
