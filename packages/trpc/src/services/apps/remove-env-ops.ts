/**
 * The real side effects of removing a cloned environment (remove-env.ts):
 * the preview-teardown way for its app and throwaway resources, `removeDb`
 * for a database it deletes, the stack-delete way for its volumes and
 * secrets, and a labelled Docker config marking whatever it kept orphaned.
 */
import { buildInventory } from '@swarmy/core';
import { authorize } from '../../abac';
import type { OrgContext } from '../../context';
import { latestLedger, lockAppEnvironment, realOps } from '../apps.service';
import { stacks } from '../apps.repo';
import { resolveManagerNode } from '../dispatch.service';
import { dbRemoveConfirmPhrase, removeDb } from '../manageddb.service';
import { removeFamiliesOfStack } from '../secret-family-remove';
import { groupSecrets, listRawSecrets } from '../secretsMgr.service';
import { removeService } from '../service.service';
import { removeStackVolumes } from '../stack-data';
import { APP_STACK_LABEL } from './live';
import type { RemoveEnvOps } from './remove-env';

const NETWORK_REMOVE_TIMEOUT_MS = 60_000;

export function realRemoveEnvOps(ctx: OrgContext): RemoveEnvOps {
  return {
    lock: lockAppEnvironment,
    ledger: (repoId, environment) => latestLedger(ctx.db, repoId, environment, 0),

    async allowDelete(stack, databases) {
      for (const name of databases)
        await authorize(ctx, 'data.destroy', { type: 'managedResource', id: `${stack}/${name}`, orgId: ctx.activeOrgId });
    },

    async teardown({ repo, sha, desired, ledger }) {
      const ops = realOps(ctx, desired, repo, sha);
      const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
      const app = buildInventory(services, containers).services.filter((s) => s.labels[APP_STACK_LABEL] === desired.stack);
      for (const s of app) await removeService(ctx, s.id).catch(() => undefined);
      for (const j of Object.values(ledger.jobs)) await ops.removeJob(j.jobId).catch(() => undefined);
      for (const peer of ledger.connect) await ops.unlink(peer).catch(() => undefined);
      // Its own caches, search, vectors and buckets (a bucket that still holds objects stays).
      for (const [name, r] of Object.entries(ledger.resources))
        if (r.type !== 'postgres') await ops.deleteResource(name, r.type, r).catch(() => undefined);
      return app.map((s) => s.name);
    },

    async deleteDatabase(stack, cluster, alsoRemoving) {
      try {
        await removeDb(ctx, { stack, cluster, confirm: dbRemoveConfirmPhrase(stack, cluster), deleteData: true, alsoRemoving });
        return true;
      } catch (e) {
        return (e as { code?: string }).code === 'NOT_FOUND'; // never provisioned: nothing to keep
      }
    },

    // The stack-delete way: every online server, then each one's volume.list proves it.
    removeVolumes: (stack, volumes) => removeStackVolumes(ctx, stack, volumes),

    async markOrphaned(marker) {
      const node = await resolveManagerNode(ctx);
      const dataB64 = Buffer.from(marker.data, 'utf8').toString('base64');
      await ctx.hub.dispatch(node.id, 'config.create', { name: marker.name, dataB64, labels: marker.labels });
    },

    async removeSecrets(stack, families) {
      if (!families.length) return { removed: [], kept: [] };
      const node = await resolveManagerNode(ctx);
      const groups = groupSecrets(await listRawSecrets(ctx, node.id), ctx.activeOrgId).families.filter((g) =>
        families.includes(g.family),
      );
      return removeFamiliesOfStack(ctx, node.id, stack, groups, () => ({ reason: 'app.environment.remove' }));
    },

    async forgetStack(stack) {
      const repo = stacks(ctx, ctx.activeOrgId);
      const row = await repo.findFirst({ where: { name: stack, orgId: ctx.activeOrgId }, select: { id: true } });
      if (row) await repo.delete({ where: { id: row.id } });
      const node = await resolveManagerNode(ctx).catch(() => null);
      // Its own overlays only (the agent removes networks labelled for this stack); fire-and-forget.
      if (node)
        void ctx.hub
          .dispatch(node.id, 'network.removeForStack', { stack }, { timeoutMs: NETWORK_REMOVE_TIMEOUT_MS })
          .catch(() => undefined);
    },
  };
}
