/**
 * Canary watcher hook (slice D2), iterated by the deploy-safety worker every
 * tick (D1 owns the loop; this module only exports `canaryTick`).
 *
 * Pure Docker-truth: in-flight canaries are `<svc>--canary` services carrying
 * `swarmy.canary.of` + `swarmy.canary.params` labels, read off the live hub
 * inventory. Each tick, every canary is judged (`decideCanary`, pure — see
 * deploy-canary.core.ts):
 *
 *  - ROLLBACK when its error rate (RED metrics from the org's ClickHouse
 *    store, entry spans) breaches `rollbackOnErrorRatePct`, or — telemetry
 *    fallback — its tasks are dead (0/desired running past a grace window):
 *    restore 100% stable traffic, remove the canary, fire an alert event and
 *    record an incident event.
 *  - PROMOTE once the watch window (`durationMin`) elapses clean: swap the
 *    stable service onto the canary image (full-spec update rebuilt from the
 *    live `docker service inspect` so nothing is silently stripped), restore
 *    the traffic weights, remove the canary.
 *
 * The pure helpers in deploy-canary.core.ts MIRROR the unit-tested canonical
 * copies in `@swarmy/trpc` releases.service.ts — a worker cannot subpath-import
 * an internal trpc module (same constraint deploy-safety documents for
 * `decideGate`).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import {
  fireEvent,
  reapplyIngressForOrg,
  recordIncidentEvent,
  systemContext,
  writeAudit,
} from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import { decryptSecret } from '@swarmy/core/crypto';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';
import {
  CANARY_OF_LABEL,
  CANARY_PARAMS_LABEL,
  INGRESS_ROUTES_LABEL,
  decideCanary,
  parseCanaryParams,
  parseRoutesLabel,
  promoteSpecFrom,
  stripCanaryFromRoutes,
} from './deploy-canary.core';

/** RED lookback window for the breach check (matches the service-map window). */
const RED_WINDOW_MINUTES = 15;
/** A canary whose tasks are all dead only counts after this grace (converging). */
const DOWN_GRACE_MIN = 2;

// ── RED metrics (org ClickHouse store; unreachable/off → null = blind) ───────

function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

interface RedRow {
  service_name: string;
  error_rate: number;
}

/** Per-OTel-service error rate over entry spans, or null when the store is off/unreachable. */
async function orgErrorRates(orgId: string): Promise<Map<string, number> | null> {
  // Cast mirrors `obsDb` in observability.service — the delegate exists once
  // the spine's prisma client is generated.
  const delegate = (
    prisma as unknown as {
      observabilityConfig: {
        findUnique(args: {
          where: { orgId: string };
        }): Promise<{ enabled: boolean; clickhouseDsn: string | null } | null>;
      };
    }
  ).observabilityConfig;
  const row = await delegate.findUnique({ where: { orgId } }).catch(() => null);
  if (!row?.enabled || !row.clickhouseDsn) return null;
  let dsnPlain: string;
  try {
    dsnPlain = decryptSecret(row.clickhouseDsn);
  } catch {
    dsnPlain = row.clickhouseDsn;
  }
  const sql = [
    'SELECT',
    '  ServiceName AS service_name,',
    `  round(countIf(StatusCode = 'STATUS_CODE_ERROR') / count(), 4) AS error_rate`,
    'FROM otel_traces',
    `WHERE ResourceAttributes['swarmy.org_id'] = ${lit(orgId)}`,
    `  AND Timestamp >= now() - INTERVAL ${RED_WINDOW_MINUTES} MINUTE`,
    `  AND (SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')`,
    'GROUP BY service_name',
    'LIMIT 100',
  ].join('\n');
  try {
    const u = new URL(dsnPlain);
    const url = new URL(`${u.protocol}//${u.host}`);
    url.searchParams.set('database', u.pathname.replace(/^\//, '') || 'otel');
    url.searchParams.set('default_format', 'JSONEachRow');
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': decodeURIComponent(u.username || 'default'),
        'X-ClickHouse-Key': decodeURIComponent(u.password || ''),
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const out = new Map<string, number>();
    for (const line of text.trim().split('\n')) {
      if (!line) continue;
      const parsed = JSON.parse(line) as RedRow;
      if (typeof parsed.service_name === 'string' && typeof parsed.error_rate === 'number') {
        out.set(parsed.service_name, parsed.error_rate);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Error rate (percent) for a service; OTel names may drop the stack prefix. */
function errorRatePctFor(
  rates: Map<string, number> | null,
  stack: string | undefined,
  name: string,
): number | null {
  if (!rates) return null;
  const candidates = [name];
  if (stack && name.startsWith(`${stack}_`)) candidates.push(name.slice(stack.length + 1));
  for (const c of candidates) {
    const rate = rates.get(c);
    if (rate !== undefined) return Math.round(rate * 10000) / 100;
  }
  return null;
}

// ── promote / rollback actions ────────────────────────────────────────────────

async function restoreStableRoutes(
  ctx: OrgContext,
  orgId: string,
  nodeId: string,
  stable: SwarmServiceInfo,
): Promise<void> {
  const routes = parseRoutesLabel(stable.labels[INGRESS_ROUTES_LABEL]);
  if (!routes.some((r) => r.canary)) return;
  await ctx.hub.dispatch(nodeId, 'service.updateLabels', {
    service: stable.name,
    add: { [INGRESS_ROUTES_LABEL]: JSON.stringify(stripCanaryFromRoutes(routes)) },
    removeKeys: [],
  });
  // Re-render + push the org ingress so the weight change lands now.
  await reapplyIngressForOrg({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId).catch(
    () => undefined,
  );
}

async function promote(
  ctx: OrgContext,
  orgId: string,
  nodeId: string,
  stable: SwarmServiceInfo,
  canary: SwarmServiceInfo,
): Promise<void> {
  const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(nodeId, 'service.inspect', {
    service: stable.name,
  });
  const spec = promoteSpecFrom(raw?.inspect, canary.image, stable.networks.map((n) => n.name));
  if (!spec) throw new Error(`cannot rebuild spec for ${stable.name}`);
  await ctx.hub.dispatch(nodeId, 'service.deploy', { spec, pullPolicy: 'always' });
  await restoreStableRoutes(ctx, orgId, nodeId, stable);
  await ctx.hub.dispatch(nodeId, 'service.remove', { service: canary.name });

  await writeAudit(ctx, {
    action: 'release.canary.promote',
    actorType: 'system',
    targetType: 'service',
    targetId: stable.name,
    metadata: { image: canary.image, canaryService: canary.name, by: 'deploy-canary worker' },
  });
  await fireEvent(ctx, {
    signal: 'deploy-canary',
    severity: 'info',
    resource: `service:${stable.name}`,
    message: `Canary promoted: ${stable.name} now runs ${canary.image}`,
  });
}

async function rollback(
  ctx: OrgContext,
  orgId: string,
  nodeId: string,
  stable: SwarmServiceInfo,
  canary: SwarmServiceInfo,
  reason: string,
): Promise<void> {
  // Stop the traffic split FIRST so no request lands on a removed upstream.
  await restoreStableRoutes(ctx, orgId, nodeId, stable);
  await ctx.hub.dispatch(nodeId, 'service.remove', { service: canary.name });

  await writeAudit(ctx, {
    action: 'release.canary.rollback',
    actorType: 'system',
    targetType: 'service',
    targetId: stable.name,
    metadata: { canaryService: canary.name, canaryImage: canary.image, reason },
  });
  await fireEvent(ctx, {
    signal: 'deploy-canary',
    severity: 'critical',
    resource: `service:${stable.name}`,
    message: `Canary rolled back on ${stable.name}: ${reason}`,
  });
  await recordIncidentEvent(ctx, {
    groupKey: `release:${stable.labels['com.docker.stack.namespace'] ?? stable.name}`,
    kind: 'deploy.canary.rollback',
    message: `Canary ${canary.name} (${canary.image}) rolled back: ${reason}`,
    severity: 'critical',
    meta: { service: stable.name, canaryImage: canary.image, reason },
  });
}

// ── tick ──────────────────────────────────────────────────────────────────────

/** One canary judgement + action; failures are contained per canary. */
async function judgeCanary(
  ctx: OrgContext,
  orgId: string,
  services: SwarmServiceInfo[],
  canary: SwarmServiceInfo,
  rates: Map<string, number> | null,
): Promise<void> {
  const stableName = canary.labels[CANARY_OF_LABEL];
  const stable = services.find((s) => s.name === stableName);
  const params = parseCanaryParams(canary.labels[CANARY_PARAMS_LABEL]);
  if (!stable || !params) return; // orphaned/unreadable — a human aborts from the UI
  const nodeId = ctx.hub.managerNode(orgId);
  if (!nodeId) return;

  const stack = canary.labels['com.docker.stack.namespace'];
  const elapsedMin = (Date.now() - Date.parse(params.startedAt)) / 60_000;
  const canaryErrorRatePct = errorRatePctFor(rates, stack, canary.name);
  const canaryDown =
    (canary.desiredReplicas ?? 0) > 0 && canary.runningReplicas === 0 && elapsedMin >= DOWN_GRACE_MIN;

  const decision = decideCanary({
    elapsedMin,
    durationMin: params.durationMin,
    rollbackOnErrorRatePct: params.rollbackOnErrorRatePct,
    canaryErrorRatePct,
    canaryDown,
  });
  if (decision === 'wait') return;
  if (decision === 'promote') {
    await promote(ctx, orgId, nodeId, stable, canary);
    return;
  }
  const reason = canaryDown
    ? `canary tasks are down (0/${canary.desiredReplicas ?? 0} running)`
    : `error rate ${canaryErrorRatePct ?? '?'}% breached the ${params.rollbackOnErrorRatePct}% ceiling`;
  await rollback(ctx, orgId, nodeId, stable, canary, reason);
}

/** The D2 hook the deploy-safety worker runs every tick. */
export const canaryTick = async (): Promise<void> => {
  const orgIds = new Set(store.nodeOrg.values());
  if (orgIds.size === 0) return;
  const auth = authRegistry.getAuth();
  for (const orgId of orgIds) {
    const { services } = hub.liveInventory(orgId);
    const canaries = services.filter((s) => s.labels[CANARY_OF_LABEL]);
    if (canaries.length === 0) continue;
    const ctx = systemContext({ db: prisma, hub, auth }, orgId);
    const rates = await orgErrorRates(orgId);
    for (const canary of canaries) {
      await judgeCanary(ctx, orgId, services, canary, rates).catch(() => undefined);
    }
  }
};
