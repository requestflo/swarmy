import {
  buildInventory,
  type ComposeDiffLine,
  type DeploySafetyView,
  type DeployStrategyView,
  type HealthGateView,
  type ReleaseDetailView,
  type ReleasesOverview,
  type ReleaseStatusView,
  type ReleaseView,
  type InvService,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { deployFromCompose } from './stack.service';

/**
 * Releases & deploy safety (slice D1) — release history, health-gated deploys,
 * rollback.
 *
 * Docker-native storage: the health gate + deploy strategy are STACK-level
 * declarative behaviour → they live on the stack's services as JSON-in-one-label
 * (`swarmy.deploy.safety`, `swarmy.deploy.strategy`), never in the DB. The
 * `Release` model is swarmy's own queryable deploy HISTORY (who shipped what,
 * when, and how the gate judged it) — exactly the kind of record the DB keeps.
 */

// ── stack-level deploy labels (Docker truth; D2 owns writing the strategy) ──
export const DEPLOY_SAFETY_LABEL = 'swarmy.deploy.safety';
export const DEPLOY_STRATEGY_LABEL = 'swarmy.deploy.strategy';

const DEFAULT_WINDOW_SEC = 120;

// ── pure: label codecs ───────────────────────────────────────────────────────

/** Parse the `swarmy.deploy.safety` JSON label → a validated health gate. */
export function parseHealthGate(raw: string | null | undefined): HealthGateView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { windowSec?: unknown; autoRollback?: unknown };
    const windowSec = Number(v.windowSec);
    if (!Number.isFinite(windowSec) || windowSec <= 0) return null;
    return { windowSec: Math.round(windowSec), autoRollback: v.autoRollback === true };
  } catch {
    return null;
  }
}

/** Parse the `swarmy.deploy.strategy` JSON label (owned by D2) → a strategy. */
export function parseStrategy(raw: string | null | undefined): DeployStrategyView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const type = v.type;
    if (type !== 'rolling' && type !== 'canary' && type !== 'bluegreen') return null;
    const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    return {
      type,
      trafficPct: num(v.trafficPct),
      durationMin: num(v.durationMin),
      rollbackOnErrorRatePct: num(v.rollbackOnErrorRatePct),
    };
  } catch {
    return null;
  }
}

// ── pure: health-gate decision ───────────────────────────────────────────────

export type GateDecision = 'wait' | 'healthy' | 'failed';

/**
 * Judge one deploying release. Canonical, unit-tested copy — the deploy-safety
 * worker mirrors it (a worker cannot subpath-import an internal trpc module).
 *
 *  - before `windowSec` elapses → wait (the stack is still converging);
 *  - after the window: healthy → healthy; degraded/down → failed;
 *  - `unknown` (health narrative has no data yet) → keep waiting up to twice
 *    the window, then pass — a gate must never wedge a release forever, and
 *    "no evidence of trouble" after 2× the watch window is a pass, not a fail.
 */
export function decideGate(input: {
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  elapsedSec: number;
  windowSec: number;
}): GateDecision {
  if (input.elapsedSec < input.windowSec) return 'wait';
  if (input.health === 'healthy') return 'healthy';
  if (input.health === 'degraded' || input.health === 'down') return 'failed';
  // unknown: grace period, then benefit of the doubt.
  return input.elapsedSec < input.windowSec * 2 ? 'wait' : 'healthy';
}

// ── pure: line diff (LCS) ────────────────────────────────────────────────────

/**
 * Simple line diff (longest-common-subsequence) between two compose sources.
 * Compose files are small (≤256KB input cap upstream), so O(n·m) is fine.
 */
export function diffLines(a: string, b: string): ComposeDiffLine[] {
  const al = a.length ? a.split('\n') : [];
  const bl = b.length ? b.split('\n') : [];
  const n = al.length;
  const m = bl.length;

  // lcs[i * (m+1) + j] = LCS length of al[i..] vs bl[j..] (flat table).
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        al[i] === bl[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }

  const out: ComposeDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = al[i] ?? '';
    const bj = bl[j] ?? '';
    if (ai === bj) {
      out.push({ kind: 'same', aLine: i + 1, bLine: j + 1, text: ai });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ kind: 'del', aLine: i + 1, bLine: null, text: ai });
      i++;
    } else {
      out.push({ kind: 'add', aLine: null, bLine: j + 1, text: bj });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', aLine: i + 1, bLine: null, text: al[i] ?? '' });
  for (; j < m; j++) out.push({ kind: 'add', aLine: null, bLine: j + 1, text: bl[j] ?? '' });
  return out;
}

// ── row ↔ view mapping ───────────────────────────────────────────────────────

const STATUS_TO_VIEW: Record<string, ReleaseStatusView> = {
  DEPLOYING: 'deploying',
  HEALTHY: 'healthy',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled-back',
  SUPERSEDED: 'superseded',
};

interface ReleaseRow {
  id: string;
  stackName: string;
  composeSource: string;
  imagesJson: unknown;
  actor: string | null;
  strategyJson: unknown;
  status: string;
  healthGateJson: unknown;
  notes: string | null;
  createdAt: Date;
}

function toView(row: ReleaseRow): ReleaseView {
  const images = Array.isArray(row.imagesJson)
    ? (row.imagesJson as { name?: unknown; image?: unknown }[])
        .filter((x) => typeof x?.name === 'string' && typeof x?.image === 'string')
        .map((x) => ({ name: x.name as string, image: x.image as string }))
    : [];
  const strategy = row.strategyJson ? parseStrategy(JSON.stringify(row.strategyJson)) : null;
  const gateRaw = row.healthGateJson as { windowSec?: unknown; autoRollback?: unknown } | null;
  const gate =
    gateRaw && Number.isFinite(Number(gateRaw.windowSec))
      ? { windowSec: Number(gateRaw.windowSec), autoRollback: gateRaw.autoRollback === true }
      : null;
  return {
    id: row.id,
    stackName: row.stackName,
    status: STATUS_TO_VIEW[row.status] ?? 'deploying',
    images,
    actor: row.actor,
    strategy,
    healthGate: gate,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── deploy hook (called by stack.service#deployFromCompose after dispatch) ───

/**
 * Snapshot a deploy as a `Release` row: compose source, resolved images (with
 * tags) from the dispatched specs, the acting user, and the stack's deploy
 * strategy + health gate read from its Docker labels. Any release still stuck
 * in `deploying` for the stack is superseded — only one gate watch per stack.
 */
export async function recordRelease(
  ctx: OrgContext,
  input: {
    stackName: string;
    composeSource: string;
    specs: ServiceSpec[];
    /** `swarmy.deploy.*` labels carried on the stack at deploy time. */
    deployLabels: Record<string, string>;
  },
): Promise<{ id: string }> {
  const gate = parseHealthGate(input.deployLabels[DEPLOY_SAFETY_LABEL]);
  const strategy = parseStrategy(input.deployLabels[DEPLOY_STRATEGY_LABEL]);
  const actor = ctx.user ? (ctx.user.email ?? ctx.user.name ?? ctx.user.id) : 'system';

  await ctx.db.release.updateMany({
    where: { orgId: ctx.activeOrgId, stackName: input.stackName, status: 'DEPLOYING' },
    data: { status: 'SUPERSEDED' },
  });

  const row = await ctx.db.release.create({
    data: {
      orgId: ctx.activeOrgId,
      stackName: input.stackName,
      composeSource: input.composeSource,
      imagesJson: input.specs.map((s) => ({ name: s.name, image: s.image })),
      actor,
      strategyJson: (strategy ?? {}) as object,
      status: 'DEPLOYING',
      healthGateJson: gate ? (gate as object) : undefined,
    },
    select: { id: true },
  });
  return { id: row.id };
}

// ── queries ──────────────────────────────────────────────────────────────────

export async function overview(ctx: OrgContext, stackName?: string): Promise<ReleasesOverview> {
  const rows = await ctx.db.release.findMany({
    where: { orgId: ctx.activeOrgId, ...(stackName ? { stackName } : {}) },
    select: { status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    deploying: count('DEPLOYING'),
    healthy: count('HEALTHY'),
    failed: count('FAILED'),
    rolledBack: count('ROLLED_BACK'),
    lastDeployAt: rows[0]?.createdAt.toISOString() ?? null,
  };
}

export async function listReleases(
  ctx: OrgContext,
  input: { stackName?: string; limit: number },
): Promise<ReleaseView[]> {
  const rows = await ctx.db.release.findMany({
    where: { orgId: ctx.activeOrgId, ...(input.stackName ? { stackName: input.stackName } : {}) },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
  });
  return rows.map(toView);
}

export async function getRelease(ctx: OrgContext, id: string): Promise<ReleaseDetailView> {
  const row = await ctx.db.release.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('release', id);
  // Previous deploy of the same stack = the diff baseline.
  const prev = await ctx.db.release.findFirst({
    where: { orgId: ctx.activeOrgId, stackName: row.stackName, createdAt: { lt: row.createdAt } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, composeSource: true },
  });
  return {
    ...toView(row),
    composeSource: row.composeSource,
    previousId: prev?.id ?? null,
    diff: diffLines(prev?.composeSource ?? '', row.composeSource),
  };
}

// ── mutations ────────────────────────────────────────────────────────────────

/**
 * Redeploy a past release's compose as a NEW release (noting what it rolls back
 * to), and mark the stack's current head release `rolled-back`. Runs the same
 * admission pipeline as any deploy; `override` is forwarded (and audited by the
 * deploy path).
 */
export async function rollbackTo(
  ctx: OrgContext,
  input: { releaseId: string; override: boolean },
): Promise<{ releaseId: string; deploymentId: string }> {
  const target = await ctx.db.release.findFirst({
    where: { id: input.releaseId, orgId: ctx.activeOrgId },
  });
  if (!target) throw notFound('release', input.releaseId);

  // The head release we are abandoning (most recent, not already end-state).
  const head = await ctx.db.release.findFirst({
    where: {
      orgId: ctx.activeOrgId,
      stackName: target.stackName,
      status: { in: ['DEPLOYING', 'HEALTHY', 'FAILED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const deployed = await deployFromCompose(ctx, {
    name: target.stackName,
    composeSource: target.composeSource,
    override: input.override,
  });

  if (head && head.id !== deployed.releaseId) {
    await ctx.db.release.update({ where: { id: head.id }, data: { status: 'ROLLED_BACK' } });
  }
  if (deployed.releaseId) {
    await ctx.db.release.update({
      where: { id: deployed.releaseId },
      data: { notes: `Rollback to release ${target.id}` },
    });
  }

  await writeAudit(ctx, {
    action: 'release.rollback',
    targetType: 'release',
    targetId: target.id,
    metadata: {
      stackName: target.stackName,
      newReleaseId: deployed.releaseId,
      rolledBackHead: head?.id ?? null,
      override: input.override,
    },
  });

  return { releaseId: deployed.releaseId ?? target.id, deploymentId: deployed.deploymentId };
}

// ── deploy-safety settings (Docker labels, never the DB) ────────────────────

function liveStackServices(ctx: OrgContext, stackName: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stackName);
}

/** Read the stack's deploy-safety + strategy labels off the live inventory. */
export async function getSafety(ctx: OrgContext, stackName: string): Promise<DeploySafetyView> {
  const svcs = liveStackServices(ctx, stackName);
  const label = (key: string): string | undefined => svcs.find((s) => s.labels[key])?.labels[key];
  const gate = parseHealthGate(label(DEPLOY_SAFETY_LABEL));
  return {
    stackName,
    enabled: gate !== null,
    windowSec: gate?.windowSec ?? DEFAULT_WINDOW_SEC,
    autoRollback: gate?.autoRollback ?? false,
    strategy: parseStrategy(label(DEPLOY_STRATEGY_LABEL)),
  };
}

/**
 * Write (or clear) the `swarmy.deploy.safety` JSON label on every service in
 * the stack — stack-level config carried on the stack's Docker objects, so the
 * gate survives a wiped database.
 */
export async function setSafety(
  ctx: OrgContext,
  input: { stackName: string; enabled: boolean; windowSec: number; autoRollback: boolean },
): Promise<DeploySafetyView> {
  const svcs = liveStackServices(ctx, input.stackName);
  if (svcs.length === 0) {
    throw commandRejected(
      `stack "${input.stackName}" has no running services to carry the safety label — deploy it first`,
    );
  }
  const node = await resolveManagerNode(ctx);
  const value = JSON.stringify({ windowSec: input.windowSec, autoRollback: input.autoRollback });
  try {
    for (const svc of svcs) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: input.enabled ? { [DEPLOY_SAFETY_LABEL]: value } : {},
        removeKeys: input.enabled ? [] : [DEPLOY_SAFETY_LABEL],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'release.setSafety',
    targetType: 'stack',
    targetId: input.stackName,
    metadata: {
      enabled: input.enabled,
      windowSec: input.windowSec,
      autoRollback: input.autoRollback,
    },
  });

  return {
    stackName: input.stackName,
    enabled: input.enabled,
    windowSec: input.windowSec,
    autoRollback: input.autoRollback,
    strategy: await getSafety(ctx, input.stackName).then((s) => s.strategy),
  };
}

// ── canary (D2) ──────────────────────────────────────────────────────────────
// Weighted canary rollouts. A `<svc>--canary` sibling service runs the
// candidate image while the stable service's `swarmy.ingress.routes` label
// carries a weighted canary upstream (rendered by the Caddy driver as
// `lb_policy weighted_round_robin <stable> <canary>`). ALL canary state is
// Docker truth — labels on the canary service — never the DB. The
// deploy-canary worker (apps/api) watches these labels each tick and
// promotes/rolls back; it mirrors the pure helpers below (a worker cannot
// subpath-import an internal trpc module).

// Imports for this appended section (ESM hoists them; kept here so the D1
// region above stays byte-identical).
import {
  STACK_LABEL,
  UNGROUPED,
  type CanaryAbortResult,
  type CanaryPromoteResult,
  type CanaryRedView,
  type CanaryRunView,
  type StartCanaryInput,
} from '@swarmy/core';
import { evaluateAdmission } from './admission.service';
import { readRoutes, type Route } from './ingress-routes';
import { setServiceRoutes } from './ingress-routes-api';
import { redSnapshot } from './observability.service';
import type { ServiceMapNodeRow } from './observability-map';

/** Marks a canary service with the stable service it shadows (Docker truth). */
export const CANARY_OF_LABEL = 'swarmy.canary.of';
/** JSON rollout parameters carried on the canary service (Docker truth). */
export const CANARY_PARAMS_LABEL = 'swarmy.canary.params';
/** Canary sibling naming: `<stable>--canary`. */
export const CANARY_SUFFIX = '--canary';

/** The `swarmy.canary.params` label payload. */
export interface CanaryParams {
  trafficPct: number;
  durationMin: number;
  rollbackOnErrorRatePct: number | null;
  /** The image the stable service ran when the canary started (for context). */
  stableImage: string;
  startedAt: string;
}

// ── pure: canary label codecs + route/spec builders (unit-tested) ────────────

export function canaryNameFor(stableService: string): string {
  return `${stableService}${CANARY_SUFFIX}`;
}

/** Parse the `swarmy.canary.params` JSON label; tolerant — bad labels → null. */
export function parseCanaryParams(raw: string | null | undefined): CanaryParams | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const trafficPct = Number(v.trafficPct);
    const durationMin = Number(v.durationMin);
    const startedAt = typeof v.startedAt === 'string' ? v.startedAt : '';
    if (!Number.isFinite(trafficPct) || trafficPct <= 0 || trafficPct > 100) return null;
    if (!Number.isFinite(durationMin) || durationMin <= 0) return null;
    if (!startedAt || Number.isNaN(Date.parse(startedAt))) return null;
    const rb = Number(v.rollbackOnErrorRatePct);
    return {
      trafficPct: Math.round(trafficPct),
      durationMin: Math.round(durationMin),
      rollbackOnErrorRatePct: Number.isFinite(rb) && rb > 0 ? rb : null,
      stableImage: typeof v.stableImage === 'string' ? v.stableImage : '',
      startedAt,
    };
  } catch {
    return null;
  }
}

/** Stamp the weighted canary upstream onto every route of the stable service. */
export function routesWithCanary(routes: Route[], canaryService: string, weightPct: number): Route[] {
  const pct = Math.min(100, Math.max(0, Math.round(weightPct)));
  return routes.map((r) => ({ ...r, canary: { service: canaryService, port: r.port, weightPct: pct } }));
}

/** Drop the canary fragment from every route (traffic back to 100% stable). */
export function routesWithoutCanary(routes: Route[]): Route[] {
  return routes.map(({ canary: _drop, ...rest }) => rest);
}

/**
 * The canary sibling's deploy spec, derived from the LIVE stable service
 * (inventory carries image/env/networks/secret+config names): same runtime
 * surface, candidate image, exactly 1 replica, no published ports (traffic
 * arrives only through the weighted ingress route), and the two canary labels.
 */
export function canarySpecFor(stable: InvService, image: string, params: CanaryParams): ServiceSpec {
  const env: Record<string, string> = {};
  for (const kv of stable.env) {
    const eq = kv.indexOf('=');
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const labels: Record<string, string> = {
    [CANARY_OF_LABEL]: stable.name,
    [CANARY_PARAMS_LABEL]: JSON.stringify(params),
  };
  if (stable.stack !== UNGROUPED) labels[STACK_LABEL] = stable.stack;
  return {
    name: canaryNameFor(stable.name),
    image,
    mode: { replicated: { replicas: 1 } },
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(stable.networks.length > 0 ? { networks: stable.networks.map((n) => n.name) } : {}),
    ...((stable.secrets ?? []).length > 0
      ? { secrets: (stable.secrets ?? []).map((s) => ({ source: s })) }
      : {}),
    ...((stable.configs ?? []).length > 0
      ? { configs: (stable.configs ?? []).map((c) => ({ source: c })) }
      : {}),
    labels,
  };
}

// ── pure: raw `docker service inspect` → ServiceSpec (for the image swap) ────

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Rebuild a full {@link ServiceSpec} from a raw `docker service inspect`
 * payload, swapping in `image`. The agent's deploy is a full-spec REPLACE, so
 * promoting a canary image onto the stable service must carry everything the
 * service already has (env, mounts, secrets, configs, ports, placement, …) or
 * the update would silently strip it. Network NAMES come from the live
 * inventory (raw inspect only carries network ids). Returns null when the
 * inspect payload is unusable.
 */
export function promoteSpecFrom(inspect: unknown, image: string, networks: string[]): ServiceSpec | null {
  const spec = asObj(asObj(inspect)?.Spec);
  const name = asStr(spec?.Name);
  if (!spec || !name) return null;
  const tt = asObj(spec.TaskTemplate) ?? {};
  const cs = asObj(tt.ContainerSpec) ?? {};

  const out: ServiceSpec = { name, image };

  const mode = asObj(spec.Mode);
  const replicas = asNum(asObj(mode?.Replicated)?.Replicas);
  if (replicas !== undefined) out.mode = { replicated: { replicas } };
  else if (mode?.Global !== undefined) out.mode = { global: {} };

  const env: Record<string, string> = {};
  for (const kv of asArr(cs.Env)) {
    if (typeof kv !== 'string') continue;
    const eq = kv.indexOf('=');
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  if (Object.keys(env).length > 0) out.env = env;

  const command = asArr(cs.Command).filter((c): c is string => typeof c === 'string');
  if (command.length > 0) out.command = command;
  const args = asArr(cs.Args).filter((a): a is string => typeof a === 'string');
  if (args.length > 0) out.args = args;

  const labels = asObj(spec.Labels);
  if (labels) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) if (typeof v === 'string') clean[k] = v;
    if (Object.keys(clean).length > 0) out.labels = clean;
  }

  const mounts: NonNullable<ServiceSpec['mounts']> = [];
  for (const m of asArr(cs.Mounts)) {
    const mo = asObj(m);
    const type = asStr(mo?.Type);
    const target = asStr(mo?.Target);
    if (!mo || !target || (type !== 'volume' && type !== 'bind' && type !== 'tmpfs')) continue;
    mounts.push({
      type,
      target,
      ...(asStr(mo.Source) ? { source: asStr(mo.Source) } : {}),
      ...(mo.ReadOnly === true ? { readOnly: true } : {}),
    });
  }
  if (mounts.length > 0) out.mounts = mounts;

  const refList = (raw: unknown[], nameKey: 'SecretName' | 'ConfigName') => {
    const refs: NonNullable<ServiceSpec['secrets']> = [];
    for (const r of raw) {
      const ro = asObj(r);
      const source = asStr(ro?.[nameKey]);
      if (!ro || !source) continue;
      const file = asObj(ro.File);
      refs.push({
        source,
        ...(asStr(file?.Name) ? { target: asStr(file?.Name) } : {}),
        ...(asStr(file?.UID) ? { uid: asStr(file?.UID) } : {}),
        ...(asStr(file?.GID) ? { gid: asStr(file?.GID) } : {}),
        ...(asNum(file?.Mode) !== undefined ? { mode: asNum(file?.Mode) } : {}),
      });
    }
    return refs;
  };
  const secrets = refList(asArr(cs.Secrets), 'SecretName');
  if (secrets.length > 0) out.secrets = secrets;
  const configs = refList(asArr(cs.Configs), 'ConfigName');
  if (configs.length > 0) out.configs = configs;

  const ports: NonNullable<ServiceSpec['ports']> = [];
  for (const p of asArr(asObj(spec.EndpointSpec)?.Ports)) {
    const po = asObj(p);
    const target = asNum(po?.TargetPort);
    if (!po || target === undefined) continue;
    const protocol = asStr(po.Protocol);
    const publishMode = asStr(po.PublishMode);
    ports.push({
      target,
      ...(asNum(po.PublishedPort) !== undefined ? { published: asNum(po.PublishedPort) } : {}),
      protocol: protocol === 'udp' ? 'udp' : 'tcp',
      mode: publishMode === 'host' ? 'host' : 'ingress',
    });
  }
  if (ports.length > 0) out.ports = ports;

  const restart = asObj(tt.RestartPolicy);
  const condition = asStr(restart?.Condition);
  if (condition === 'none' || condition === 'on-failure' || condition === 'any') {
    out.restartPolicy = {
      condition,
      ...(asNum(restart?.MaxAttempts) !== undefined ? { maxAttempts: asNum(restart?.MaxAttempts) } : {}),
    };
  }

  const constraints = asArr(asObj(tt.Placement)?.Constraints).filter(
    (c): c is string => typeof c === 'string',
  );
  if (constraints.length > 0) out.placement = { constraints };

  const res = asObj(tt.Resources);
  const resourcesOf = (side: unknown) => {
    const o = asObj(side);
    const nano = asNum(o?.NanoCPUs);
    const mem = asNum(o?.MemoryBytes);
    if (nano === undefined && mem === undefined) return undefined;
    return {
      ...(nano !== undefined ? { cpus: nano / 1e9 } : {}),
      ...(mem !== undefined ? { memoryBytes: mem } : {}),
    };
  };
  const limits = resourcesOf(res?.Limits);
  const reservations = resourcesOf(res?.Reservations);
  if (limits || reservations) {
    out.resources = { ...(limits ? { limits } : {}), ...(reservations ? { reservations } : {}) };
  }

  const hc = asObj(cs.Healthcheck);
  const test = asArr(hc?.Test).filter((t): t is string => typeof t === 'string');
  if (hc && test.length > 0) {
    out.healthcheck = {
      test,
      ...(asNum(hc.Interval) !== undefined ? { intervalNs: asNum(hc.Interval) } : {}),
      ...(asNum(hc.Timeout) !== undefined ? { timeoutNs: asNum(hc.Timeout) } : {}),
      ...(asNum(hc.StartPeriod) !== undefined ? { startPeriodNs: asNum(hc.StartPeriod) } : {}),
      ...(asNum(hc.Retries) !== undefined ? { retries: asNum(hc.Retries) } : {}),
    };
  }
  const stopGrace = asNum(cs.StopGracePeriod);
  if (stopGrace !== undefined) out.stopGracePeriodNs = stopGrace;

  if (networks.length > 0) out.networks = networks;
  return out;
}

// ── live lookups ─────────────────────────────────────────────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

/** Resolve the STABLE service by stack + (name | `<stack>_<name>` | id). */
function requireStableService(ctx: OrgContext, stack: string, service: string): InvService {
  const match = liveOrgServices(ctx).find(
    (s) =>
      s.stack === stack &&
      !s.labels[CANARY_OF_LABEL] &&
      (s.name === service || s.id === service || s.name === `${stack}_${service}`),
  );
  if (!match) throw notFound('service', `${stack}/${service}`);
  if (match.name.endsWith(CANARY_SUFFIX)) {
    throw commandRejected(`"${match.name}" is itself a canary service`);
  }
  return match;
}

/** RED aggregate for one service name (OTel names may drop the stack prefix). */
function redFor(rows: ServiceMapNodeRow[], stack: string, name: string): CanaryRedView {
  const names = new Set([name]);
  if (stack !== UNGROUPED && name.startsWith(`${stack}_`)) names.add(name.slice(stack.length + 1));
  const row = rows.find((r) => names.has(r.service_name));
  if (!row) return { errorRatePct: null, p95Ms: null };
  return { errorRatePct: Math.round(row.error_rate * 10000) / 100, p95Ms: row.p95_ms };
}

function toCanaryView(
  canary: InvService,
  stable: InvService,
  params: CanaryParams | null,
  redRows: ServiceMapNodeRow[],
): CanaryRunView {
  const p: CanaryParams = params ?? {
    trafficPct: 0,
    durationMin: 0,
    rollbackOnErrorRatePct: null,
    stableImage: stable.image,
    startedAt: new Date(0).toISOString(),
  };
  const elapsedMin = Math.max(0, (Date.now() - Date.parse(p.startedAt)) / 60_000);
  const routedHosts = [
    ...new Set(
      readRoutes(stable.labels)
        .filter((r) => r.canary?.service === canary.name)
        .map((r) => r.host),
    ),
  ];
  return {
    stack: stable.stack,
    service: stable.name,
    canaryService: canary.name,
    stableImage: stable.image,
    canaryImage: canary.image,
    trafficPct: p.trafficPct,
    durationMin: p.durationMin,
    rollbackOnErrorRatePct: p.rollbackOnErrorRatePct,
    startedAt: p.startedAt,
    elapsedMin: Math.round(elapsedMin * 10) / 10,
    remainingMin: Math.max(0, Math.round((p.durationMin - elapsedMin) * 10) / 10),
    routedHosts,
    stableReplicas: { desired: stable.replicas.desired, running: stable.replicas.running },
    canaryReplicas: { desired: canary.replicas.desired, running: canary.replicas.running },
    stableRed: redFor(redRows, stable.stack, stable.name),
    canaryRed: redFor(redRows, canary.stack, canary.name),
  };
}

// ── canary queries ───────────────────────────────────────────────────────────

/**
 * Every in-flight canary (optionally one stack's), read live off the
 * `swarmy.canary.*` labels + RED metrics from the observability store.
 */
export async function canaryStatus(ctx: OrgContext, input: { stack?: string }): Promise<CanaryRunView[]> {
  const all = liveOrgServices(ctx);
  const canaries = all.filter(
    (s) => s.labels[CANARY_OF_LABEL] && (!input.stack || s.stack === input.stack),
  );
  if (canaries.length === 0) return [];
  const red = await redSnapshot(ctx).catch(() => null);
  const rows = red?.reachable ? red.rows : [];
  const out: CanaryRunView[] = [];
  for (const canary of canaries) {
    const stable = all.find((s) => s.name === canary.labels[CANARY_OF_LABEL]);
    if (!stable) continue; // stable gone — nothing to compare or promote onto
    out.push(toCanaryView(canary, stable, parseCanaryParams(canary.labels[CANARY_PARAMS_LABEL]), rows));
  }
  return out;
}

// ── canary mutations ─────────────────────────────────────────────────────────

/**
 * Start a weighted canary: deploy `<svc>--canary` on the candidate image
 * (1 replica, same env/networks/secret refs, canary labels) and stamp a
 * weighted canary upstream onto every ingress route of the stable service.
 * The deploy-canary worker then promotes after a clean window or rolls back
 * on error-rate breach / task death.
 */
export async function startCanary(ctx: OrgContext, input: StartCanaryInput): Promise<CanaryRunView> {
  const stable = requireStableService(ctx, input.stack, input.service);
  const canaryName = canaryNameFor(stable.name);
  if (liveOrgServices(ctx).some((s) => s.labels[CANARY_OF_LABEL] === stable.name || s.name === canaryName)) {
    throw commandRejected(`a canary for "${stable.name}" is already running — promote or abort it first`);
  }
  if (input.image === stable.image) {
    throw commandRejected(`"${stable.name}" already runs ${input.image} — pick a different image/tag`);
  }

  const params: CanaryParams = {
    trafficPct: input.trafficPct,
    durationMin: input.durationMin,
    rollbackOnErrorRatePct: input.rollbackOnErrorRatePct,
    stableImage: stable.image,
    startedAt: new Date().toISOString(),
  };
  const spec = canarySpecFor(stable, input.image, params);

  // A canary is a service deploy — the admission pipeline still applies.
  const violations = await evaluateAdmission(ctx, {
    kind: 'service.deploy',
    orgId: ctx.activeOrgId,
    stackName: stable.stack === UNGROUPED ? undefined : stable.stack,
    specs: [spec],
  });
  const blocking = violations.filter((v) => v.severity === 'block');
  if (blocking.length > 0) {
    throw commandRejected(`canary refused by policy: ${blocking.map((v) => v.message).join('; ')}`);
  }

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Shift trafficPct of every route to the canary (no routes = observe-only).
  const routes = readRoutes(stable.labels);
  if (routes.length > 0) {
    await setServiceRoutes(ctx, stable.id, routesWithCanary(routes, canaryName, input.trafficPct));
  }

  await writeAudit(ctx, {
    action: 'release.canary.start',
    targetType: 'service',
    targetId: stable.name,
    metadata: {
      stack: stable.stack,
      canaryService: canaryName,
      image: input.image,
      stableImage: stable.image,
      trafficPct: input.trafficPct,
      durationMin: input.durationMin,
      rollbackOnErrorRatePct: input.rollbackOnErrorRatePct,
      routedHosts: routes.map((r) => r.host),
    },
  });

  return toCanaryView(
    { ...stable, name: canaryName, image: input.image, labels: spec.labels ?? {}, replicas: { desired: 1, running: 0 } },
    stable,
    params,
    [],
  );
}

/**
 * Promote: swap the stable service onto the canary image (full-spec update
 * rebuilt from the live inspect so nothing is stripped), restore 100% of the
 * traffic, then retire the `--canary` sibling.
 */
export async function promoteCanary(
  ctx: OrgContext,
  input: { stack: string; service: string },
): Promise<CanaryPromoteResult> {
  const stable = requireStableService(ctx, input.stack, input.service);
  const canary = liveOrgServices(ctx).find((s) => s.labels[CANARY_OF_LABEL] === stable.name);
  if (!canary) throw notFound('canary', stable.name);

  const node = await resolveManagerNode(ctx);
  try {
    const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', {
      service: stable.name,
    });
    const spec = promoteSpecFrom(raw?.inspect, canary.image, stable.networks.map((n) => n.name));
    if (!spec) throw commandRejected(`could not read the live spec of "${stable.name}" to promote onto`);
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });

    // Traffic back to 100% stable (now on the promoted image)…
    const routes = readRoutes(stable.labels);
    if (routes.some((r) => r.canary)) {
      await setServiceRoutes(ctx, stable.id, routesWithoutCanary(routes));
    }
    // …then retire the canary sibling.
    await ctx.hub.dispatch(node.id, 'service.remove', { service: canary.name });
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'release.canary.promote',
    targetType: 'service',
    targetId: stable.name,
    metadata: { stack: stable.stack, image: canary.image, canaryService: canary.name },
  });

  return { service: stable.name, image: canary.image };
}

/**
 * Abort: restore 100% of the traffic to the stable service (untouched, still
 * on its original image) and remove the canary sibling.
 */
export async function abortCanary(
  ctx: OrgContext,
  input: { stack: string; service: string },
): Promise<CanaryAbortResult> {
  const stable = requireStableService(ctx, input.stack, input.service);
  const canary = liveOrgServices(ctx).find((s) => s.labels[CANARY_OF_LABEL] === stable.name);
  if (!canary) throw notFound('canary', stable.name);

  const node = await resolveManagerNode(ctx);
  try {
    // Stop the traffic split FIRST so no request lands on a removed upstream.
    const routes = readRoutes(stable.labels);
    if (routes.some((r) => r.canary)) {
      await setServiceRoutes(ctx, stable.id, routesWithoutCanary(routes));
    }
    await ctx.hub.dispatch(node.id, 'service.remove', { service: canary.name });
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'release.canary.abort',
    targetType: 'service',
    targetId: stable.name,
    metadata: { stack: stable.stack, canaryService: canary.name, canaryImage: canary.image },
  });

  return { service: stable.name };
}
