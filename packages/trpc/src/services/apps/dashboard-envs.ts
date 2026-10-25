/**
 * Environments the dashboard declared (Clone as a new environment). They are
 * represented exactly like swarmy.yaml environments — AppPlan rows with
 * `environment: <name>`, `prNumber: 0`, stack `<app>-<name>`, services
 * stamped `swarmy.app.environment=<name>` — and the row's desired state
 * carries the `dashboard` marker (branch, source, data, secret slots) that
 * makes it re-plannable while swarmy.yaml doesn't name it. The newest row
 * per environment decides: once the file declares it, the marker is gone;
 * once it is removed (remove-env.ts), every row loses it.
 */
import {
  cloneDesired,
  type AppConfig,
  type DashboardEnvironment,
  type DashboardEnvMarker,
  type DesiredApp,
  type SecretSlot,
} from '@swarmy/app-config';
import { buildInventory, type InvService } from '@swarmy/core';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../../context';
import { commandRejected } from '../../errors';
import { parsePhysicalSecretName } from '../secretsMgr.service';
import { emptyLedger } from './live';

export interface DashboardEnvRow {
  environment: string;
  stack: string;
  marker: DashboardEnvMarker;
}

const NOT_ENVS = ['?', 'preview', 'production'];

/** Every environment of a repo whose newest plan the dashboard declared. */
export async function dashboardEnvironments(db: DB, repoId: string): Promise<DashboardEnvRow[]> {
  const rows = await db.appPlan.findMany({
    where: { repoId, prNumber: 0, NOT: { environment: { in: NOT_ENVS } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { environment: true, stack: true, desiredJson: true },
  });
  const seen = new Set<string>();
  const out: DashboardEnvRow[] = [];
  for (const r of rows) {
    if (seen.has(r.environment)) continue;
    seen.add(r.environment);
    const marker = (r.desiredJson as unknown as DesiredApp | null)?.dashboard;
    if (marker) out.push({ environment: r.environment, stack: r.stack, marker });
  }
  return out;
}

/** The status every plan row of a removed dashboard environment ends in (remove-env.ts). */
export const REMOVED = 'removed';

/** The environments this repo still has: the newest row of each, unless it was removed. */
export async function takenEnvironments(db: DB, repoId: string): Promise<string[]> {
  const rows = await db.appPlan.findMany({
    where: { repoId, prNumber: 0 },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { environment: true, status: true },
  });
  const newest = new Map<string, string>();
  for (const r of rows) if (!newest.has(r.environment)) newest.set(r.environment, r.status);
  return [...newest].filter(([, status]) => status !== REMOVED).map(([env]) => env);
}

/**
 * Drop the marker from every plan row of a dashboard environment, so nothing
 * re-plans it (push, poll, replan), and mark the rows removed with an empty
 * ledger — its history stays readable, its lane and its name go.
 */
export async function forgetDashboardEnvironment(db: DB, repoId: string, environment: string): Promise<number> {
  const rows = await db.appPlan.findMany({
    where: { repoId, environment, prNumber: 0 },
    select: { id: true, desiredJson: true },
  });
  for (const r of rows) {
    const desired = r.desiredJson as unknown as DesiredApp | null;
    const { dashboard: _marker, ...rest } = desired ?? ({} as DesiredApp);
    await db.appPlan.update({
      where: { id: r.id },
      data: { status: REMOVED, ledgerJson: emptyLedger() as never, ...(desired ? { desiredJson: rest as never } : {}) },
    });
  }
  return rows.length;
}

export function asClone(row: Pick<DashboardEnvRow, 'environment' | 'marker'>): DashboardEnvironment {
  const { branch, from, data } = row.marker;
  return { name: row.environment, branch, from, ...(data ? { data } : {}) };
}

/** `cloneDesired`, with its plain-words refusals as a rejected command. `opts.hostFor`: clone-hosts.ts. */
export function dashboardDesired(cfg: AppConfig, clone: DashboardEnvironment, opts: Parameters<typeof cloneDesired>[2] = {}): DesiredApp {
  try {
    return cloneDesired(cfg, clone, opts);
  } catch (e) {
    throw commandRejected(e instanceof Error ? e.message : String(e));
  }
}

export interface SecretSlotView extends SecretSlot {
  /** Every consumer in the environment's stack mounts its own family (Docker truth). */
  filled: boolean;
}

/** PURE — which slots this environment has filled, read off the live services' secret refs. */
export function slotStates(slots: readonly SecretSlot[], stack: string, services: readonly InvService[]): SecretSlotView[] {
  const mounts = (svc: string, family: string): boolean =>
    services.some(
      (s) => s.name === `${stack}_${svc}` && (s.secrets ?? []).some((n) => parsePhysicalSecretName(n)?.family === family),
    );
  return slots.map((s) => ({ ...s, filled: s.consumers.every((c) => mounts(c.service, s.envFamily)) }));
}

/** One dashboard environment as `apps.list` shows it (its slots read live). */
export function dashboardEnvView<L>(ctx: OrgContext, environment: string, stack: string, marker: DashboardEnvMarker, latest: L) {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services;
  return {
    environment,
    branch: marker.branch,
    stack,
    latest,
    keptVolumes: [] as Array<{ resource: string; volumes: string[] }>,
    dashboard: {
      from: marker.from,
      ...(marker.data ? { data: marker.data } : {}),
      secretSlots: slotStates(marker.secretSlots ?? [], stack, live),
    },
  };
}
