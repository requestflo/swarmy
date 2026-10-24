/**
 * Remove a cloned environment (board Environments: the lane's "Remove
 * environment"). Only one the dashboard declared: production, a stack marked
 * production, and every environment swarmy.yaml names are refused — those go
 * by editing the file. It tears the stack down the way a preview teardown
 * does (its app services, jobs, links and its own caches/search/vectors/
 * buckets), keeps or deletes its database as asked — keep (the default)
 * leaves the Postgres running in its stack with its backups, for Data to
 * remove later — removes the environment's OWN secret families (`<x>.<env>`,
 * never a shared one) and drops the dashboard marker from its plan rows so
 * nothing re-plans it. Typed confirmation (the stack name); `stack.remove`
 * on the stack (the router), plus `data.destroy` per database it deletes;
 * audited `app.environment.remove`.
 */
import { ENV_LABEL } from '@swarmy/abac';
import { PRODUCTION, type DesiredApp } from '@swarmy/app-config';
import { liveStackLabels } from '../../abac';
import type { OrgContext } from '../../context';
import { commandRejected, notFound } from '../../errors';
import { writeAudit } from '../audit.service';
import { dashboardEnvironments, forgetDashboardEnvironment, REMOVED } from './dashboard-envs';
import type { AppLedger } from './live';

export type DatabaseChoice = 'keep' | 'delete';

export interface RemoveEnvironmentInput {
  /** The environment's stack (`shop-qa`). */
  stack: string;
  /** The stack name, typed. */
  confirm: string;
  database: DatabaseChoice;
}

export interface RemoveEnvironmentResult {
  environment: string;
  stack: string;
  /** App services removed. */
  services: string[];
  /** Postgres resources by outcome: `kept` keep running in the stack. */
  databases: { kept: string[]; deleted: string[] };
  /** The environment's own secret families; `kept` = a service outside it still mounts one. */
  secrets: { removed: string[]; kept: string[] };
}

export interface EnvTeardown {
  repo: { id: string; branch: string };
  sha: string;
  desired: DesiredApp;
  ledger: AppLedger;
}

/** The side effects, injectable for tests (remove-env-ops.ts is the real one). */
export interface RemoveEnvOps {
  lock<T>(repoId: string, environment: string, fn: () => Promise<T>): Promise<T>;
  ledger(repoId: string, environment: string): Promise<AppLedger>;
  /** `data.destroy` on each database about to be deleted (throws FORBIDDEN, audited). */
  allowDelete(stack: string, databases: readonly string[]): Promise<void>;
  /** App services, jobs, links and every non-Postgres resource; returns the services removed. */
  teardown(t: EnvTeardown): Promise<string[]>;
  /** Remove one Postgres and its data on every server; false when it could not. */
  deleteDatabase(stack: string, cluster: string, alsoRemoving: readonly string[]): Promise<boolean>;
  removeSecrets(stack: string, families: readonly string[]): Promise<{ removed: string[]; kept: string[] }>;
  /** Nothing is left: forget the stack's config row and its networks. */
  forgetStack(stack: string): Promise<void>;
}

const postgresNames = (desired: DesiredApp, ledger: AppLedger): string[] =>
  [...new Set([...desired.resources, ...Object.values(ledger.resources)].filter((r) => r.type === 'postgres').map((r) => r.name))].sort();

export async function removeEnvironment(
  ctx: OrgContext,
  input: RemoveEnvironmentInput,
  ops: RemoveEnvOps,
): Promise<RemoveEnvironmentResult> {
  const { stack } = input;
  if (input.confirm.trim() !== stack) throw commandRejected(`type ${stack} to remove this environment`);
  const row = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, stack, prNumber: 0 },
    orderBy: { createdAt: 'desc' },
    select: { repoId: true, environment: true, sha: true, status: true, desiredJson: true },
  });
  if (!row || row.status === REMOVED) throw notFound('environment', stack);
  const environment = row.environment;
  if (environment === PRODUCTION || liveStackLabels(ctx, stack)?.[ENV_LABEL] === PRODUCTION)
    throw commandRejected(`${stack} is production — it can’t be removed from here`);
  const declared = (await dashboardEnvironments(ctx.db, row.repoId)).find((e) => e.environment === environment);
  if (!declared)
    throw commandRejected(`swarmy.yaml declares ${environment} — remove environments.${environment} from the file instead`);
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: row.repoId, orgId: ctx.activeOrgId }, select: { id: true, branch: true } });
  if (!repo) throw notFound('repo', row.repoId);

  const desired = row.desiredJson as unknown as DesiredApp;
  const ledger = await ops.ledger(repo.id, environment);
  const databases = postgresNames(desired, ledger);
  if (input.database === 'delete') await ops.allowDelete(stack, databases);

  return ops.lock(repo.id, environment, async () => {
    const services = await ops.teardown({ repo, sha: row.sha, desired, ledger });
    const deleted: string[] = [];
    const kept: string[] = [];
    for (const name of databases)
      (input.database === 'delete' && (await ops.deleteDatabase(stack, name, services)) ? deleted : kept).push(name);
    const families = declared.marker.secretSlots.map((s) => s.envFamily);
    const secrets = await ops.removeSecrets(stack, families).catch(() => ({ removed: [], kept: families }));
    if (!kept.length) await ops.forgetStack(stack).catch(() => undefined);
    await forgetDashboardEnvironment(ctx.db, repo.id, environment);
    await writeAudit(ctx, {
      action: 'app.environment.remove',
      targetType: 'gitRepo',
      targetId: repo.id,
      metadata: { environment, stack, database: input.database, services, databases: { kept, deleted }, secrets },
    });
    return { environment, stack, services, databases: { kept, deleted }, secrets };
  });
}
