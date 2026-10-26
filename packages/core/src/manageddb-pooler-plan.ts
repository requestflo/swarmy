/**
 * What the manageddb reconcile does about a cluster's pooler this tick.
 * PURE: the cluster's declaration (`swarmy.db.pooler` on the primary), its
 * writer and the live pooler service in; one decision out. The worker step
 * (apps/api manageddb-pooler.ts) carries it out.
 *
 *   off, no pooler            → steady
 *   off, a pooler             → remove it (and its auth secret)
 *   on, no writer             → wait
 *   on, no pooler / no auth   → deploy, minting the auth role first (needs
 *                               the writer running: the role is SQL on it)
 *   on, pooler, same inputs   → steady (the stamped signature matches)
 *   on, pooler, changed input → deploy (mode, pool size, writer, image rev)
 */
import type { ServiceSpec } from './protocol/commands';
import { parseDbSecretName } from './manageddb-pg';
import type { PoolerConfig } from './manageddb-pooler';
import {
  DB_POOLER_AUTH_LABEL,
  DB_POOLER_SIG_LABEL,
  DB_POOLER_TARGET_LABEL,
  POOLER_DRAIN_SECONDS,
  poolerImageOf,
  poolerSignature,
  poolerSpec,
} from './manageddb-pooler-spec';

interface LiveLike {
  name: string;
  image: string;
  labels: Record<string, string>;
}

export interface PoolerPlanInput {
  stack: string;
  cluster: string;
  declared: PoolerConfig | null;
  /** The cluster's writer (its base primary) and how many of its tasks run. */
  writer?: { name: string; running: number };
  pooler?: LiveLike;
}

export type PoolerPlan =
  | { kind: 'steady' }
  | { kind: 'wait'; reason: string }
  | { kind: 'remove'; service: string; authSecret: string | null }
  | {
      kind: 'deploy';
      create: boolean;
      config: PoolerConfig;
      target: string;
      image: string;
      /** The auth secret to mount; null = mint one (and the writer's role) first. */
      authSecret: string | null;
      /** The writer the live pooler points at now (an update). */
      from: string | null;
    };

export function planPooler(i: PoolerPlanInput): PoolerPlan {
  if (!i.declared) {
    return i.pooler ? { kind: 'remove', service: i.pooler.name, authSecret: i.pooler.labels[DB_POOLER_AUTH_LABEL] ?? null } : { kind: 'steady' };
  }
  if (!i.writer) return { kind: 'wait', reason: 'the cluster has no main copy to point the pooler at' };
  const authSecret = i.pooler?.labels[DB_POOLER_AUTH_LABEL] ?? null;
  const image = poolerImageOf(i.pooler?.image);
  const base = { kind: 'deploy' as const, config: i.declared, target: i.writer.name, image, from: i.pooler?.labels[DB_POOLER_TARGET_LABEL] ?? null };
  if (!authSecret) {
    if (i.writer.running < 1) return { kind: 'wait', reason: `${i.writer.name} is not running, and the pooler's login is set up on it` };
    return { ...base, create: !i.pooler, authSecret: null };
  }
  const sig = poolerSignature({ stack: i.stack, cluster: i.cluster, config: i.declared, target: i.writer.name, authSecret, image });
  if (i.pooler?.labels[DB_POOLER_SIG_LABEL] === sig) return { kind: 'steady' };
  return { ...base, create: false, authSecret };
}

/**
 * The auth secret to mint: one version past every `family` version Docker
 * still lists (a removed pooler's secret may linger while a task drains), and
 * the older ones to retire once the new pooler runs.
 */
export function nextAuthSecret(family: string, existing: readonly string[]): { name: string; stale: string[] } {
  const mine = existing.filter((n) => parseDbSecretName(n)?.family === family);
  const top = mine.reduce((v, n) => Math.max(v, parseDbSecretName(n)!.version), 0);
  return { name: `${family}__v${top + 1}`, stale: mine.sort() };
}

export interface PoolerRepoint {
  service: string;
  /** The writer it pointed at (the demoted ex-primary). */
  from: string | null;
  to: string;
  spec: ServiceSpec;
  /** The incident-timeline line for the drain. */
  message: string;
}

/**
 * After a promotion, in the same pass that repoints the other members: the
 * pooler rebuilt at the new writer with its existing login. The new task
 * answers first (start-first); the old one drains, finishing in-flight
 * transactions for up to {@link POOLER_DRAIN_SECONDS}. Built by the same
 * `poolerSpec` the next tick checks, so that tick is steady. Null when there
 * is no pooler, it has no login yet (the converge creates it at the new
 * writer), or it already points there.
 */
export function planPoolerRepoint(i: { declared: PoolerConfig | null; pooler?: LiveLike; promoted: string; stack: string; cluster: string }): PoolerRepoint | null {
  const authSecret = i.pooler?.labels[DB_POOLER_AUTH_LABEL];
  if (!i.declared || !i.pooler || !authSecret) return null;
  const from = i.pooler.labels[DB_POOLER_TARGET_LABEL] ?? null;
  if (from === i.promoted) return null;
  const spec = poolerSpec({ stack: i.stack, cluster: i.cluster, config: i.declared, target: i.promoted, authSecret, image: poolerImageOf(i.pooler.image) });
  return {
    service: spec.name,
    from,
    to: i.promoted,
    spec,
    message:
      `Drained ${spec.name} off ${from ?? 'the old writer'}: a new pooler task sends apps to ${i.promoted}, ` +
      `the old one finishes in-flight transactions (up to ${POOLER_DRAIN_SECONDS} s) and stops`,
  };
}
