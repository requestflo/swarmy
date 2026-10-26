import {
  DB_FAILOVER_PENDING_LABEL,
  appRepointSignature,
  planAppRepoint,
  switchoverRequested,
  type AppRepointPlan,
  type RepointStandby,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { RepointAppsResult } from '@swarmy/trpc';

/**
 * Apps follow the writer — the manageddb reconcile's step for apps wired
 * STRAIGHT to a cluster (`db.inject`, not through the pooler), whose
 * `DATABASE_URL` names the writer's own service. The plan is pure
 * (@swarmy/core `planAppRepoint`); the re-mint + rolling redeploy is
 * @swarmy/trpc `repointDbApps`, through the seams the reconcile hands over.
 *
 *   followPromotion  in the promotion pass, after the copies and the pooler:
 *                    the writer is NAMED (the inventory hasn't seen the label
 *                    flip yet) and the demoted writer counts as down.
 *   followWriter     every tick: an app whose URL still names another host
 *                    than the running writer (a controller restart mid-pass,
 *                    a redeploy that failed) is moved. The gate is the app's
 *                    own `swarmy.db.inject.host` against the writer, so a
 *                    steady tick sends nothing; the same move is retried at
 *                    most once a minute.
 */

export interface AppsCluster {
  stack: string;
  cluster: string;
  primary?: SwarmServiceInfo;
  /** The replica-role members (base replica + region siblings). */
  standbys: readonly SwarmServiceInfo[];
}

export interface AppsSeams {
  repoint(o: { writer?: string; standbys?: RepointStandby[] }): Promise<RepointAppsResult>;
}

const RETRY_MS = 60_000;
/** `${org}/${stack}/${cluster}` → the last move attempted and when (process memory; a restart retries at once). */
const attempted = new Map<string, { signature: string; at: number }>();

const standbyOf = (s: SwarmServiceInfo): RepointStandby => ({
  service: s.name,
  running: s.runningReplicas ?? 0,
  ...(s.labels['swarmy.db.region'] ? { region: s.labels['swarmy.db.region'] } : {}),
});

/** PURE — the apps this tick would move, or null (steady, or not now: no running writer, a held failover, a switch-over in flight). */
export function appsToFollow(c: AppsCluster, services: readonly SwarmServiceInfo[], now: number): AppRepointPlan | null {
  const writer = c.primary;
  if (!writer || (writer.runningReplicas ?? 0) < 1) return null;
  if ([writer, ...c.standbys].some((s) => s.labels[DB_FAILOVER_PENDING_LABEL] !== undefined)) return null;
  if (switchoverRequested(writer.labels, now)) return null;
  const plan = planAppRepoint({ stack: c.stack, cluster: c.cluster, writer: writer.name, standbys: c.standbys.map(standbyOf), services });
  return plan.moves.length > 0 ? plan : null;
}

/** Each tick: move what a promotion pass left. True when it called the repoint. */
export async function followWriter(
  key: string,
  c: AppsCluster,
  services: readonly SwarmServiceInfo[],
  seams: AppsSeams,
  now = Date.now(),
): Promise<boolean> {
  const plan = appsToFollow(c, services, now);
  if (!plan) {
    attempted.delete(key);
    return false;
  }
  const signature = appRepointSignature(plan);
  const last = attempted.get(key);
  if (last && last.signature === signature && now - last.at < RETRY_MS) return false;
  attempted.set(key, { signature, at: now });
  await seams.repoint({});
  return true;
}

/** In the promotion pass: every direct app onto `promoted`. The old writer is down (it re-clones). */
export function followPromotion(c: AppsCluster, promoted: string, seams: AppsSeams): Promise<RepointAppsResult> {
  const standbys = c.standbys.filter((s) => s.name !== promoted).map(standbyOf);
  if (c.primary && c.primary.name !== promoted) standbys.push({ service: c.primary.name, running: 0 });
  return seams.repoint({ writer: promoted, standbys });
}

/** Test hook: forget the retry memory. */
export function resetAppsFollow(): void {
  attempted.clear();
}
