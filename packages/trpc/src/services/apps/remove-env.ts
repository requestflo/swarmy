/**
 * Remove a cloned environment (board Environments: the lane's "Remove
 * environment"). Only one the dashboard declared: production, a stack marked
 * production, and every environment swarmy.yaml names are refused — those go
 * by editing the file. What goes and what stays is one pure plan
 * (remove-env-plan.ts): the stack is torn down the way a preview teardown
 * does (its app services, and with them their routes and addresses, its jobs,
 * links and its own caches/search/vectors/buckets), its own secret families
 * (`<x>.<env>`, never a shared one) are removed, and its data is kept or
 * deleted as asked, the way stack removal does. Keep (the default) leaves its
 * databases running with their backups and its volumes on the servers,
 * marked orphaned for GC; delete removes both from every server. Then the
 * dashboard marker is dropped from its plan rows so nothing re-plans it.
 * Typed confirmation (the stack name); `stack.remove` on the stack (the
 * router), plus `data.destroy` per database it deletes; audited
 * `app.environment.remove`.
 */
import { ENV_LABEL } from '@swarmy/abac';
import { PRODUCTION, type DesiredApp } from '@swarmy/app-config';
import { liveStackLabels } from '../../abac';
import type { OrgContext } from '../../context';
import { commandRejected, notFound } from '../../errors';
import { writeAudit } from '../audit.service';
import { dashboardEnvironments, forgetDashboardEnvironment, REMOVED } from './dashboard-envs';
import type { AppLedger } from './live';
import { orphanMarker, planEnvRemoval, type DataChoice, type OrphanMarker } from './remove-env-plan';

export interface RemoveEnvironmentInput {
  /** The environment's stack (`shop-qa`). */
  stack: string;
  /** The stack name, typed. */
  confirm: string;
  /** Its databases and volumes: kept (marked orphaned) or deleted on every server. */
  data: DataChoice;
}

export interface RemoveEnvironmentResult {
  environment: string;
  stack: string;
  /** App services removed. */
  services: string[];
  /** Addresses that stopped answering with them. */
  hosts: string[];
  /** Postgres resources by outcome: `kept` keep running in the stack. */
  databases: { kept: string[]; deleted: string[] };
  /** Named volumes by outcome: `kept` stay on the servers (marked orphaned) or would not go. */
  volumes: { kept: string[]; deleted: string[] };
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
  /** Remove named volumes on every server; `failed` = still there afterwards. */
  removeVolumes(stack: string, volumes: readonly string[]): Promise<{ deleted: string[]; failed: string[] }>;
  /** Mark what was kept orphaned (a labelled Docker config a GC finds). */
  markOrphaned(marker: OrphanMarker): Promise<void>;
  removeSecrets(stack: string, families: readonly string[]): Promise<{ removed: string[]; kept: string[] }>;
  /** Nothing is left: forget the stack's config row and its networks. */
  forgetStack(stack: string): Promise<void>;
}

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
  // Read before anything goes: the live app services name its routes and volumes.
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const secretFamilies = declared.marker.secretSlots.map((s) => s.envFamily);
  const plan = planEnvRemoval({ stack, data: input.data, desired, ledger, live, secretFamilies });
  if (plan.remove.databases.length) await ops.allowDelete(stack, plan.remove.databases);

  return ops.lock(repo.id, environment, async () => {
    const services = await ops.teardown({ repo, sha: row.sha, desired, ledger });
    const deleted: string[] = [];
    const kept = [...plan.keep.databases];
    for (const name of plan.remove.databases) ((await ops.deleteDatabase(stack, name, services)) ? deleted : kept).push(name);
    const gone = plan.remove.volumes.length
      ? await ops.removeVolumes(stack, plan.remove.volumes).catch(() => ({ deleted: [], failed: plan.remove.volumes }))
      : { deleted: [], failed: [] };
    const volumes = { kept: [...plan.keep.volumes, ...gone.failed].sort(), deleted: gone.deleted };
    const secrets = await ops.removeSecrets(stack, plan.remove.secrets).catch(() => ({ removed: [], kept: plan.remove.secrets }));
    const marker = orphanMarker(ctx.activeOrgId, stack, environment, { databases: kept.sort(), volumes: volumes.kept }, nonce());
    if (marker) await ops.markOrphaned(marker).catch(() => undefined);
    if (!kept.length) await ops.forgetStack(stack).catch(() => undefined);
    await forgetDashboardEnvironment(ctx.db, repo.id, environment);
    const result = { environment, stack, services, hosts: plan.remove.hosts, databases: { kept, deleted }, volumes, secrets };
    await writeAudit(ctx, {
      action: 'app.environment.remove',
      targetType: 'gitRepo',
      targetId: repo.id,
      metadata: { ...result, data: input.data, ...(marker ? { orphanMarker: marker.name } : {}) },
    });
    return result;
  });
}

const nonce = (): string => Math.random().toString(36).slice(2, 8).padEnd(6, '0');
