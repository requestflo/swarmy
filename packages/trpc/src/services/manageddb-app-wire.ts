import {
  DB_INJECT_HOST_LABEL,
  DB_INJECT_RO_HOST_LABEL,
  DB_INJECT_VIA_LABEL,
  STACK_LABEL,
  dbSecretFamily,
  parseDbSecretName,
  startFirstAllowed,
  type DbConnectVia,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { patchLiveService, type LiveServiceRef } from './service-patch';

export interface AppUrlWiring {
  stack: string;
  cluster: string;
  envVar: string;
  roVar: string;
  via: DbConnectVia;
  network: string;
  rwSecret: string;
  roSecret: string;
  rwHost: string;
  roHost: string;
  /** The failover repoint: start the new task first where the app allows it. */
  rolling?: boolean;
}

/**
 * Point an app at its URL secrets in ONE redeploy over its full live spec:
 * the secret refs delivered as env (`secretEnv`, `_FILE` for a shell-less
 * image), the cluster network, and the `swarmy.db.inject*` labels, including
 * the hosts its URLs name (what the reconcile compares with the writer).
 */
export async function wireAppUrlSecrets(ctx: OrgContext, app: LiveServiceRef, w: AppUrlWiring, nodeId?: string): Promise<void> {
  const families = new Set((['url', 'ro-url', 'pool-url'] as const).map((k) => dbSecretFamily(w.stack, w.cluster, k)));
  const vars = new Set([w.envVar, w.roVar]);
  await patchLiveService(
    ctx,
    app,
    {
      removeEnv: [w.envVar, w.roVar], // any plaintext copy (a pre-secret attach) goes
      addNetworks: [w.network],
      removeLabels: [DB_INJECT_VIA_LABEL, DB_INJECT_HOST_LABEL],
      setLabels: {
        'swarmy.managed': 'true',
        [STACK_LABEL]: w.stack,
        'swarmy.db.inject': w.cluster,
        'swarmy.db.inject.var': w.envVar,
        [DB_INJECT_RO_HOST_LABEL]: w.roHost,
        ...(w.via === 'pooler' ? { [DB_INJECT_VIA_LABEL]: 'pooler' } : { [DB_INJECT_HOST_LABEL]: w.rwHost }),
      },
      transform: (spec) => ({
        ...spec,
        secrets: [
          ...(spec.secrets ?? []).filter((r) => !families.has(parseDbSecretName(r.source)?.family ?? '') && !vars.has(r.target ?? r.source)),
          { source: w.rwSecret, target: w.envVar },
          { source: w.roSecret, target: w.roVar },
        ],
        secretEnv: [...new Set([...(spec.secretEnv ?? []), ...vars])].sort(),
        secretEnvFileFallback: [...new Set([...(spec.secretEnvFileFallback ?? []), ...vars])].sort(),
        ...(w.rolling && startFirstAllowed(spec) ? { updateConfig: { ...(spec.updateConfig ?? {}), order: 'start-first' as const } } : {}),
      }),
    },
    nodeId ? { nodeId } : {},
  );
}
