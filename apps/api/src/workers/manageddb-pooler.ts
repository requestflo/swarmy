import {
  DB_POOLER_LABEL,
  DB_SECRET_KIND_LABEL,
  DB_SECRET_OF_LABEL,
  dbSecretFamily,
  nextAuthSecret,
  parseDbSecretName,
  parsePoolerConfig,
  planPooler,
  poolerRoleScript,
  poolerSpec,
  type PoolerPlan,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { poolerPassword, scramVerifier } from './manageddb-pooler-auth';

/**
 * Managed Postgres pooler — the manageddb reconcile's per-cluster step. The
 * decision is pure (`planPooler` in @swarmy/core); this runs it through the
 * seams the reconcile hands over:
 *
 *   create  mint the pooler's login (a new `…-pg-pooler__v<n>` secret with a
 *           random password, and `swarmy_pooler` on the writer set from its
 *           SCRAM verifier), then deploy `<stack>_<cluster>-pooler`.
 *   update  redeploy with the same login (mode, pool size, writer changed).
 *   remove  the service, then its login secret (best effort: Docker keeps a
 *           secret a draining task still mounts; the next create retires it).
 * A steady tick sends nothing: the plan compares signatures, not specs.
 */

export interface PoolerCluster {
  stack: string;
  cluster: string;
  primary?: SwarmServiceInfo;
  pooler?: SwarmServiceInfo;
}

export interface PoolerSeams {
  deploy(spec: ServiceSpec): Promise<unknown>;
  remove(service: string): Promise<unknown>;
  ensureNet(): Promise<unknown>;
  /** Docker secret names, or null when they can't be listed now. */
  listSecrets(): Promise<string[] | null>;
  createSecret(name: string, value: string, labels: Record<string, string>): Promise<boolean>;
  removeSecret(name: string): Promise<unknown>;
  /** `sh -c <script> swarmy-pooler <args…>` in the writer; null when nothing ran. */
  execOnWriter(script: string, args: string[]): Promise<{ exitCode: number; output: string } | null>;
  audit(action: string, metadata: Record<string, unknown>): Promise<unknown>;
}

export type PoolerStep = PoolerPlan['kind'] | 'blocked';

async function mintLogin(c: PoolerCluster, seams: PoolerSeams): Promise<{ secret: string; stale: string[] } | null> {
  const listed = await seams.listSecrets();
  if (!listed) return null;
  const { name, stale } = nextAuthSecret(dbSecretFamily(c.stack, c.cluster, 'pooler'), listed);
  const password = poolerPassword();
  const labels = {
    'swarmy.managed': 'true',
    'swarmy.db.cluster': c.cluster,
    [DB_SECRET_OF_LABEL]: `${c.stack}/${c.cluster}`,
    [DB_SECRET_KIND_LABEL]: 'pooler',
    'swarmy.secret.version': String(parseDbSecretName(name)?.version ?? 1),
  };
  if (!(await seams.createSecret(name, password, labels))) return null;
  const res = await seams.execOnWriter(poolerRoleScript(), [scramVerifier(password)]);
  if (!res || res.exitCode !== 0) {
    // Its password is gone with this tick; the next one mints a new version.
    await seams.removeSecret(name);
    return null;
  }
  return { secret: name, stale };
}

export async function convergeDbPooler(c: PoolerCluster, seams: PoolerSeams): Promise<PoolerStep> {
  const plan = planPooler({
    stack: c.stack,
    cluster: c.cluster,
    declared: parsePoolerConfig(c.primary?.labels[DB_POOLER_LABEL]),
    ...(c.primary ? { writer: { name: c.primary.name, running: c.primary.runningReplicas ?? 0 } } : {}),
    ...(c.pooler ? { pooler: c.pooler } : {}),
  });
  if (plan.kind === 'steady' || plan.kind === 'wait') return plan.kind;
  if (plan.kind === 'remove') {
    await seams.remove(plan.service);
    if (plan.authSecret) await seams.removeSecret(plan.authSecret);
    await seams.audit('db.pooler.remove', { service: plan.service });
    return 'remove';
  }
  let authSecret = plan.authSecret;
  let stale: string[] = [];
  if (!authSecret) {
    const minted = await mintLogin(c, seams);
    if (!minted) return 'blocked';
    authSecret = minted.secret;
    stale = minted.stale;
  }
  const spec = poolerSpec({ stack: c.stack, cluster: c.cluster, config: plan.config, target: plan.target, authSecret, image: plan.image });
  await seams.ensureNet();
  await seams.deploy(spec);
  for (const old of stale) await seams.removeSecret(old);
  await seams.audit(plan.create ? 'db.pooler.create' : 'db.pooler.update', {
    service: spec.name,
    target: plan.target,
    ...(plan.from && plan.from !== plan.target ? { from: plan.from } : {}),
    mode: plan.config.mode,
    poolSize: plan.config.poolSize,
    auth: authSecret,
  });
  return 'deploy';
}
