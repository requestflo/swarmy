import { DB_INJECT_VIA_LABEL, buildInventory, connectViaOf, dbSecretFamily, parseDbSecretName, type DbConnectVia, type InvService } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { clusterNetworkName, DB_INJECT_LABEL, DB_INJECT_VAR_LABEL, roVarName } from './manageddb.service';
import { patchLiveService } from './service-patch';

/**
 * Disconnect an app from a managed Postgres (`db.detach`): the exact reverse
 * of `db.inject`, whichever way it was wired (direct, or through the pooler).
 * Removes the writer + RO variables (the URL secret refs, their secret-env
 * delivery and `_FILE` fallback), the cluster network and the
 * `swarmy.db.inject*` labels, in one redeploy over the full live spec. The
 * URL secrets themselves stay until a rotation retires their version (other
 * apps may mount the same one).
 */

const URL_KINDS = ['url', 'ro-url', 'pool-url'] as const;

/** Apps in `stack` wired to `cluster` through its pooler (the pooler can't go while they are). */
export function appsThroughPooler(services: readonly Pick<InvService, 'name' | 'labels'>[], cluster: string): string[] {
  return services.filter((s) => s.labels[DB_INJECT_LABEL] === cluster && connectViaOf(s.labels) === 'pooler').map((s) => s.name);
}

export async function detachConnection(
  ctx: OrgContext,
  input: { stack: string; cluster: string; appService: string },
): Promise<{ appService: string; cluster: string; envVar: string; via: DbConnectVia; detached: true }> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const app = buildInventory(services, containers).services.find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);
  if (app.labels[DB_INJECT_LABEL] !== input.cluster) {
    throw commandRejected(`${app.name} is not connected to ${input.cluster}`);
  }
  const envVar = app.labels[DB_INJECT_VAR_LABEL] || 'DATABASE_URL';
  const roVar = roVarName(envVar);
  const via = connectViaOf(app.labels);
  const families = new Set(URL_KINDS.map((k) => dbSecretFamily(input.stack, input.cluster, k)));
  const vars = new Set([envVar, roVar]);

  await patchLiveService(ctx, app, {
    removeEnv: [envVar, roVar, `${envVar}_FILE`, `${roVar}_FILE`],
    removeNetworks: [clusterNetworkName(input.stack, input.cluster)],
    removeLabels: [DB_INJECT_LABEL, DB_INJECT_VAR_LABEL, DB_INJECT_VIA_LABEL],
    transform: (spec) => {
      const out = { ...spec };
      const secrets = (spec.secrets ?? []).filter((r) => {
        const fam = parseDbSecretName(r.source)?.family;
        return !(fam && families.has(fam)) && !vars.has(r.target ?? r.source);
      });
      const secretEnv = (spec.secretEnv ?? []).filter((n) => !vars.has(n));
      const fallback = (spec.secretEnvFileFallback ?? []).filter((n) => !vars.has(n));
      if (secrets.length) out.secrets = secrets;
      else delete out.secrets;
      if (secretEnv.length) out.secretEnv = secretEnv;
      else delete out.secretEnv;
      if (fallback.length) out.secretEnvFileFallback = fallback;
      else delete out.secretEnvFileFallback;
      return out;
    },
  });
  await writeAudit(ctx, {
    action: 'db.detach',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { appService: app.name, envVar, via },
  });
  return { appService: app.name, cluster: input.cluster, envVar, via, detached: true };
}
