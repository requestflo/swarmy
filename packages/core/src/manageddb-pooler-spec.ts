/**
 * The managed pooler's service spec: `<stack>_<cluster>-pooler`, one
 * PgBouncer task on the cluster's overlay (no published port), pointed at the
 * writer, health-checked, updated start-first so a repoint drains the old
 * task while the new one already answers. PURE — the reconcile and the
 * failover repoint both build it here, so they can never disagree.
 *
 * Its labels are its own state (Docker is the truth):
 *   swarmy.db.role=pooler          marks it (not a Postgres member)
 *   swarmy.db.pooler.target        the writer it points at
 *   swarmy.db.pooler.auth          the auth secret it mounts (`…-pg-pooler__v<n>`)
 *   swarmy.db.pooler.sig           the signature of everything it was built from
 * The reconcile redeploys only when the signature it computes from the
 * cluster's labels differs from the stamped one (a steady tick sends nothing).
 */
import type { ServiceSpec } from './protocol/commands';
import { dataImage, dataImageOfRef } from './data-images';
import { STACK_LABEL, SWARMY_MANAGED_LABEL } from './inventory';
import { parseDbSecretName } from './manageddb-pg';
import { POOLER_PORT, poolerServiceName, type PoolerConfig } from './manageddb-pooler';
import { POOLER_AUTH_USER, POOLER_ENV, POOLER_HEALTH_TEST, POOLER_MAX_CLIENTS, poolerBootCommand } from './manageddb-pooler-boot';

export const POOLER_ROLE = 'pooler';
export const DB_POOLER_TARGET_LABEL = 'swarmy.db.pooler.target';
export const DB_POOLER_AUTH_LABEL = 'swarmy.db.pooler.auth';
export const DB_POOLER_SIG_LABEL = 'swarmy.db.pooler.sig';
/** Bumped when the boot script or spec shape changes, so every pooler is rebuilt once. */
export const POOLER_SPEC_REV = '1';
/** How long a replaced pooler task gets to finish in-flight transactions. */
export const POOLER_DRAIN_SECONDS = 20;
const SECOND_NS = 1_000_000_000;

export interface PoolerSpecInput {
  stack: string;
  cluster: string;
  config: PoolerConfig;
  /** The writer service it points at (its swarm DNS name). */
  target: string;
  /** The auth role's password secret (`<family>__v<n>`). */
  authSecret: string;
  /** The image to run: the live pooler's (kept), else the BOM's. */
  image: string;
}

/** The live pooler's image back to its BOM ref (pinned/mirrored forms), else minus its digest; none = the BOM's. */
export function poolerImageOf(live?: string): string {
  if (!live?.trim()) return dataImage('pgbouncer').ref;
  return dataImageOfRef(live)?.ref ?? live.split('@')[0]!.trim();
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic signature of the pooler's inputs (`p<rev>-<hash>`). */
export function poolerSignature(i: PoolerSpecInput): string {
  const parts = [i.stack, i.cluster, i.config.mode, String(i.config.poolSize), i.target, i.authSecret, i.image];
  return `p${POOLER_SPEC_REV}-${fnv(parts.join('\n'))}`;
}

export function poolerSpec(i: PoolerSpecInput): ServiceSpec {
  const family = parseDbSecretName(i.authSecret)?.family ?? i.authSecret;
  return {
    name: poolerServiceName(i.stack, i.cluster),
    image: i.image,
    mode: { replicated: { replicas: 1 } },
    command: poolerBootCommand(),
    env: {
      [POOLER_ENV.host]: i.target,
      [POOLER_ENV.port]: '5432',
      [POOLER_ENV.mode]: i.config.mode,
      [POOLER_ENV.poolSize]: String(i.config.poolSize),
      [POOLER_ENV.maxClients]: String(POOLER_MAX_CLIENTS),
      [POOLER_ENV.authUser]: POOLER_AUTH_USER,
      [POOLER_ENV.authFile]: `/run/secrets/${family}`,
    },
    labels: {
      [SWARMY_MANAGED_LABEL]: 'true',
      [STACK_LABEL]: i.stack,
      'swarmy.db.cluster': i.cluster,
      'swarmy.db.role': POOLER_ROLE,
      // Apps hold connections to it: never scaled to zero.
      'swarmy.scaleToZero.exempt': 'true',
      [DB_POOLER_TARGET_LABEL]: i.target,
      [DB_POOLER_AUTH_LABEL]: i.authSecret,
      [DB_POOLER_SIG_LABEL]: poolerSignature(i),
    },
    networks: [`${i.stack}_${i.cluster}-net`],
    secrets: [{ source: i.authSecret, target: family }],
    healthcheck: { test: POOLER_HEALTH_TEST, intervalNs: 10 * SECOND_NS, timeoutNs: 5 * SECOND_NS, startPeriodNs: 10 * SECOND_NS, retries: 3 },
    // The new task answers before the old one drains: a repoint is never a gap.
    updateConfig: { parallelism: 1, order: 'start-first' },
    stopGracePeriodNs: POOLER_DRAIN_SECONDS * SECOND_NS,
    restartPolicy: { condition: 'any', delayNs: 5 * SECOND_NS },
    resources: { limits: { memoryBytes: 128 * 1024 * 1024 } },
  };
}

/** `host:port` apps reach it at on the cluster network. */
export function poolerAddress(stack: string, cluster: string): string {
  return `${poolerServiceName(stack, cluster)}:${POOLER_PORT}`;
}
