/**
 * Apps follow the writer. PURE.
 *
 * An app wired to a managed Postgres DIRECTLY (`db.inject`, not through the
 * pooler) carries a `DATABASE_URL` naming the writer's own service. When the
 * writer changes (an automatic failover, a planned switch-over), the
 * reconcile's promotion pass re-mints that URL for the new writer as a new
 * secret version and rolls the app onto it; the next ticks finish whatever a
 * pass left undone (a controller restart mid-pass).
 *
 * Which host an app's URLs name is Docker truth on the app itself, stamped by
 * every wiring (connect, rotation, repoint) next to the secret it mounts:
 *   swarmy.db.inject.host     the writer host its DATABASE_URL names
 *   swarmy.db.inject.roHost   the host its DATABASE_RO_URL names
 * An app wired before these labels existed was wired to the base
 * `<stack>_<cluster>-primary` / `-replica` (what connect always named).
 *
 *   pooled  through the pooler: the pooler follows the writer; never touched.
 *   steady  its URL already names the writer: nothing to do (a second tick).
 *   moves   its URL names another host: re-mint, roll it. Its read-only URL
 *           stays on a running standby; one that named the promoted copy (or
 *           a copy that isn't running) moves to a running standby, or to the
 *           writer when there is none.
 */
import { DB_INJECT_VIA_LABEL } from './manageddb-pooler';

export const DB_INJECT_HOST_LABEL = 'swarmy.db.inject.host';
export const DB_INJECT_RO_HOST_LABEL = 'swarmy.db.inject.roHost';

export interface RepointStandby {
  service: string;
  running: number;
  /** A geo region sibling (`swarmy.db.region`): the base standby is preferred. */
  region?: string;
}

interface ServiceLike {
  name: string;
  labels: Record<string, string>;
}

export interface AppRepointMove {
  service: string;
  envVar: string;
  /** The writer host its URL names now. */
  from: string;
  roFrom: string;
  /** The read-only host it gets. */
  ro: string;
}

export interface AppRepointPlan {
  writer: string;
  moves: AppRepointMove[];
  steady: string[];
  pooled: string[];
}

/** The writer host an app's DATABASE_URL names (its label, else what connect always named). */
export function appWriterHost(labels: Record<string, string>, stack: string, cluster: string): string {
  return labels[DB_INJECT_HOST_LABEL] || `${stack}_${cluster}-primary`;
}

function appRoHost(labels: Record<string, string>, stack: string, cluster: string): string {
  return labels[DB_INJECT_RO_HOST_LABEL] || `${stack}_${cluster}-replica`;
}

/** Apps in `stack` wired to `cluster` (not its own members). */
export function wiredApps<S extends ServiceLike>(services: readonly S[], stack: string, cluster: string): S[] {
  return services.filter(
    (s) => s.labels['com.docker.stack.namespace'] === stack && s.labels['swarmy.db.inject'] === cluster && s.labels['swarmy.db.cluster'] !== cluster,
  );
}

export function planAppRepoint(i: {
  stack: string;
  cluster: string;
  writer: string;
  standbys: readonly RepointStandby[];
  services: readonly ServiceLike[];
}): AppRepointPlan {
  const running = i.standbys.filter((s) => s.service !== i.writer && s.running > 0);
  const spare = [...running].sort((a, b) => Number(Boolean(a.region)) - Number(Boolean(b.region)) || a.service.localeCompare(b.service))[0];
  const plan: AppRepointPlan = { writer: i.writer, moves: [], steady: [], pooled: [] };
  for (const app of [...wiredApps(i.services, i.stack, i.cluster)].sort((a, b) => a.name.localeCompare(b.name))) {
    if (app.labels[DB_INJECT_VIA_LABEL] === 'pooler') {
      plan.pooled.push(app.name);
      continue;
    }
    const from = appWriterHost(app.labels, i.stack, i.cluster);
    if (from === i.writer) {
      plan.steady.push(app.name);
      continue;
    }
    const roFrom = appRoHost(app.labels, i.stack, i.cluster);
    const keepRo = running.some((s) => s.service === roFrom);
    plan.moves.push({
      service: app.name,
      envVar: app.labels['swarmy.db.inject.var'] || 'DATABASE_URL',
      from,
      roFrom,
      ro: keepRo ? roFrom : (spare?.service ?? i.writer),
    });
  }
  return plan;
}

/**
 * The database the app URLs name: `POSTGRES_DB` off the members, the writer
 * first. A promoted standby never had it in its env (only the first writer
 * did, and the demoted one keeps it), so every member is asked.
 */
export function clusterDatabase(members: ReadonlyArray<{ env?: readonly string[] }>, fallback = 'app'): string {
  for (const m of members) {
    const kv = (m.env ?? []).find((e) => e.startsWith('POSTGRES_DB='));
    if (kv && kv.length > 'POSTGRES_DB='.length) return kv.slice('POSTGRES_DB='.length);
  }
  return fallback;
}

/** Deterministic: equal while the same apps would move the same way (the worker's retry gate). */
export function appRepointSignature(p: AppRepointPlan): string {
  return `${p.writer}|${p.moves.map((m) => `${m.service}>${m.ro}`).join(',')}`;
}

/** The timeline line for one app. */
export function appRepointMessage(m: Pick<AppRepointMove, 'service'>, writer: string): string {
  return `Repointed ${m.service} at ${writer}`;
}

interface RollingSpecLike {
  ports?: ReadonlyArray<{ mode?: string; published?: number }>;
  mounts?: ReadonlyArray<{ type: string; readOnly?: boolean }>;
}

/**
 * Can the app's new task start before the old one stops? Not when it
 * publishes a port on the host (the second task can't bind it), nor when it
 * writes to a volume or bind mount (two copies on one data directory isn't
 * safe for every app). Otherwise yes: the app keeps answering during the roll.
 */
export function startFirstAllowed(spec: RollingSpecLike): boolean {
  if ((spec.ports ?? []).some((p) => p.mode === 'host' && p.published !== undefined)) return false;
  return !(spec.mounts ?? []).some((m) => m.type !== 'tmpfs' && !m.readOnly);
}
