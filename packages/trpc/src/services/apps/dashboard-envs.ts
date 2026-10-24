/**
 * Environments the dashboard declared (Clone as a new environment). They are
 * represented exactly like swarmy.yaml environments — AppPlan rows with
 * `environment: <name>`, `prNumber: 0`, stack `<app>-<name>`, services
 * stamped `swarmy.app.environment=<name>` — and the row's desired state
 * carries the `dashboard` marker (branch, source, data, secret slots) that
 * makes it re-plannable while swarmy.yaml doesn't name it. The newest row
 * per environment decides: once the file declares it, the marker is gone.
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

export function asClone(row: Pick<DashboardEnvRow, 'environment' | 'marker'>): DashboardEnvironment {
  const { branch, from, data } = row.marker;
  return { name: row.environment, branch, from, ...(data ? { data } : {}) };
}

/** `cloneDesired`, with its plain-words refusals as a rejected command. */
export function dashboardDesired(cfg: AppConfig, clone: DashboardEnvironment): DesiredApp {
  try {
    return cloneDesired(cfg, clone);
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
