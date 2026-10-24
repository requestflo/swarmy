/**
 * Where the controller backups are, read straight from the swarm (P4 slice 3:
 * "a controller that loses its volume and has no replica still knows where
 * its backups are"). The disaster-restore CLI (`apps/api/src/restore.ts`) has
 * no hub and no control.db, so it reads swarm-kv through a manager's Docker
 * socket (`@swarmy/core/swarm-kv-docker`) and opens the documents with
 * SWARMY_SECRET_KEY (the installer's state.env holds it).
 *
 * The `ctl-backup/controller` document names the target; `bkp-target/<id>`
 * holds it, with its credentials as vault `*Ref` blobs decrypted here, in
 * memory, for the restic call only. Pure over the injected {@link KvDriver}.
 */
import { KV_LABEL_COLLECTION, KV_LABEL_ID, KV_LABEL_ORG, SwarmKv, type KvDriver, type KvSealer } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import type { BackupTargetDoc, ControllerBackupConfigDoc } from './backups.repo';
import { KV_COLLECTIONS, vaultSealer } from './swarm-kv.service';

export interface KvRestoreTarget {
  orgId: string;
  targetId: string;
  name: string;
  kind: 's3' | 'node';
  endpoint?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  resticPassword: string;
}

/** Orgs whose swarm-kv holds `collection` (or `collection/id`), the most recently written first. */
async function orgsHolding(driver: KvDriver, collection: string, id?: string): Promise<string[]> {
  const newest = new Map<string, number>();
  for (const c of await driver.list()) {
    const org = c.labels[KV_LABEL_ORG];
    if (!org || c.labels[KV_LABEL_COLLECTION] !== collection) continue;
    if (id !== undefined && c.labels[KV_LABEL_ID] !== id) continue;
    newest.set(org, Math.max(newest.get(org) ?? 0, c.createdAt));
  }
  return [...newest].sort((a, b) => b[1] - a[1]).map(([org]) => org);
}

function open(org: string, targetId: string, t: BackupTargetDoc): KvRestoreTarget {
  const dec = (ref: string | null, what: string): string | undefined => {
    if (!ref) return undefined;
    try {
      return decryptSecret(ref);
    } catch (e) {
      throw new Error(`backup destination "${t.name}": can't decrypt its ${what} (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  return {
    orgId: org,
    targetId,
    name: t.name,
    kind: String(t.kind).toLowerCase() === 'node' ? 'node' : 's3',
    endpoint: t.endpoint ?? undefined,
    bucket: t.bucket,
    prefix: t.prefix ?? undefined,
    region: t.region ?? undefined,
    accessKeyId: dec(t.credentialRef, 'access key'),
    secretAccessKey: dec(t.secretKeyRef, 'secret key'),
    resticPassword: dec(t.resticPasswordRef, 'restic password')!,
  };
}

/**
 * The controller-backup destination as the swarm records it, or null when the
 * swarm holds none. `target` (an id or a destination name) picks another
 * destination than the one controller backups are configured to use.
 */
export async function readRestoreTargetFromKv(
  driver: KvDriver,
  opts: { target?: string; sealer?: KvSealer } = {},
): Promise<KvRestoreTarget | null> {
  const sealer = opts.sealer ?? vaultSealer;
  const store = (orgId: string) => new SwarmKv({ orgId, driver, sealer, collections: KV_COLLECTIONS });
  if (opts.target) {
    for (const org of await orgsHolding(driver, 'bkp-target')) {
      const docs = await store(org).list<BackupTargetDoc>('bkp-target');
      const hit = docs.find((d) => d.id === opts.target) ?? docs.find((d) => d.value.name === opts.target);
      if (hit) return open(org, hit.id, hit.value);
    }
    throw new Error(`no backup destination "${opts.target}" in the swarm's config`);
  }
  for (const org of await orgsHolding(driver, 'ctl-backup', 'controller')) {
    const kv = store(org);
    const cfg = await kv.get<ControllerBackupConfigDoc>('ctl-backup', 'controller');
    if (!cfg?.targetId) continue;
    const t = await kv.get<BackupTargetDoc>('bkp-target', cfg.targetId);
    if (!t) throw new Error(`controller backups point at destination ${cfg.targetId}, which the swarm no longer holds`);
    return open(org, cfg.targetId, t);
  }
  return null;
}
