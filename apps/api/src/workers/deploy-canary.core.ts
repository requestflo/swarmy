/**
 * Pure canary logic for the deploy-canary worker (slice D2) — label codecs,
 * the promote/rollback decision fn and the inspect→spec rebuild. No imports
 * beyond @swarmy/core types so `bun test` runs it without evaluating the
 * whole @swarmy/trpc router graph.
 *
 * These MIRROR the unit-tested canonical copies in `@swarmy/trpc`
 * releases.service.ts — a worker cannot subpath-import an internal trpc
 * module (same constraint deploy-safety documents for `decideGate`).
 */
import type { ServiceSpec } from '@swarmy/core/protocol';

// ── Label scheme — kept in sync with @swarmy/trpc releases.service.ts (D2) ───
export const CANARY_OF_LABEL = 'swarmy.canary.of';
export const CANARY_PARAMS_LABEL = 'swarmy.canary.params';
export const INGRESS_ROUTES_LABEL = 'swarmy.ingress.routes';

// ── params codec ──────────────────────────────────────────────────────────────

export interface CanaryParams {
  trafficPct: number;
  durationMin: number;
  rollbackOnErrorRatePct: number | null;
  stableImage: string;
  startedAt: string;
}

/** Mirror of releases.service `parseCanaryParams` (tolerant; bad → null). */
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

// ── decision fn ───────────────────────────────────────────────────────────────

export type CanaryDecision = 'wait' | 'promote' | 'rollback';

/**
 * Judge one in-flight canary. Order matters:
 *  1. dead tasks (fallback health signal) → rollback, whatever the clock says;
 *  2. error-rate breach (when a threshold is set AND telemetry has data) → rollback;
 *  3. watch window elapsed clean → promote;
 *  4. otherwise keep watching.
 * No telemetry never blocks promotion — "no evidence of trouble" after a clean
 * window is a pass (same philosophy as D1's health gate on `unknown`).
 */
export function decideCanary(input: {
  elapsedMin: number;
  durationMin: number;
  rollbackOnErrorRatePct: number | null;
  /** Canary error rate as a percent (0–100), or null when telemetry is blind. */
  canaryErrorRatePct: number | null;
  /** Fallback signal: desired > 0 but 0 tasks running past the grace window. */
  canaryDown: boolean;
}): CanaryDecision {
  if (input.canaryDown) return 'rollback';
  if (
    input.rollbackOnErrorRatePct !== null &&
    input.canaryErrorRatePct !== null &&
    input.canaryErrorRatePct > input.rollbackOnErrorRatePct
  ) {
    return 'rollback';
  }
  if (input.elapsedMin >= input.durationMin) return 'promote';
  return 'wait';
}

// ── route canary stamping (mirror of releases.service helpers) ────────────────

export interface RouteCanaryFragment {
  service: string;
  port: number;
  weightPct: number;
}
export type LabelRoute = Record<string, unknown> & { canary?: RouteCanaryFragment };

/** Tolerant parse of the `swarmy.ingress.routes` label (bad label → []). */
export function parseRoutesLabel(raw: string | undefined): LabelRoute[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((r): r is LabelRoute => typeof r === 'object' && r !== null)
      : [];
  } catch {
    return [];
  }
}

/** Drop the canary fragment from every route (traffic back to 100% stable). */
export function stripCanaryFromRoutes(routes: LabelRoute[]): LabelRoute[] {
  return routes.map(({ canary: _drop, ...rest }) => rest);
}

// ── raw docker inspect → ServiceSpec (mirror of promoteSpecFrom) ──────────────

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
 * Mirror of releases.service `promoteSpecFrom` (unit-tested there): rebuild a
 * FULL ServiceSpec from a raw `docker service inspect` payload with the canary
 * image swapped in — the agent's deploy replaces the whole spec, so anything
 * missing here would be stripped from the stable service.
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
    ports.push({
      target,
      ...(asNum(po.PublishedPort) !== undefined ? { published: asNum(po.PublishedPort) } : {}),
      protocol: asStr(po.Protocol) === 'udp' ? 'udp' : 'tcp',
      mode: asStr(po.PublishMode) === 'host' ? 'host' : 'ingress',
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
