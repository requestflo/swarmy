/**
 * Platform-key garbage collection (QA-081): ask every consumer which Garage
 * key it currently holds, then delete the platform keys nobody holds. Run by
 * storage-reconcile; the pure rules are `planPlatformKeyGc` in platform-keys.ts.
 *
 * A consumer whose state can't be read reports null for its purpose and is
 * skipped — "couldn't tell" is never "unused".
 */
import { decryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { backupTargets } from './backups.repo';
import { gcPlatformKeysWith } from './buckets.service';
import { buildLogStoreKeyIds } from './build-log-store';
import { controllerReplicaKeyIds } from './controllerStore.service';
import { edgeCertStorageKeyIds } from './ingress.service';
import { meshConfigRepo } from './mesh-config.repo';
import { managedOf } from './mesh-control.service';
import type { PlatformKeyPurposeId } from './platform-keys';
import { rumStoreKeyIds } from './rum/rum-store';
import { storageClusterRepo } from './storage-cluster.repo';

async function known(fn: () => Promise<string[] | null>): Promise<string[] | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Which key each platform purpose holds right now (null = unknown). */
export async function platformKeysInUse(
  ctx: OrgContext,
): Promise<Record<PlatformKeyPurposeId, string[] | null>> {
  const orgId = ctx.activeOrgId;
  const [presign, control, buildLogs, rum, edgeCerts, mesh, backups] = await Promise.all([
    known(async () => {
      const row = await storageClusterRepo.find(ctx, orgId);
      return row?.accessKeyRef ? [decryptSecret(row.accessKeyRef)] : [];
    }),
    known(() => controllerReplicaKeyIds()),
    known(() => buildLogStoreKeyIds(ctx)),
    known(() => rumStoreKeyIds(ctx)),
    known(() => edgeCertStorageKeyIds(ctx)),
    known(async () => {
      const m = managedOf(await meshConfigRepo.get(ctx, orgId));
      return m?.litestream?.accessKeyId ? [m.litestream.accessKeyId] : [];
    }),
    known(async () => {
      // Every backup target's key counts (not only the native one): volume,
      // DB, WAL-shipping and controller backups all read their creds off a
      // target row.
      const rows = (await backupTargets(ctx, orgId).findMany({ where: { orgId } })) as Array<{
        credentialRef?: string | null;
      }>;
      return rows.flatMap((r) => (r.credentialRef ? [decryptSecret(r.credentialRef)] : []));
    }),
  ]);
  return {
    presign,
    'control-litestream': control,
    'build-logs': buildLogs,
    rum,
    'edge-certs': edgeCerts,
    // Minted and revoked inside one purge call — anything left is a leftover.
    'edge-certs-purge': [],
    'mesh-litestream': mesh,
    backups,
  };
}

/** Delete the platform keys no consumer holds. Returns the deleted key ids. */
export async function gcPlatformKeys(ctx: OrgContext, now = Date.now()): Promise<string[]> {
  return gcPlatformKeysWith(ctx, await platformKeysInUse(ctx), now);
}
