import { createHash } from 'node:crypto';
import {
  DB_SECRET_HOST_LABEL,
  DB_SECRET_KIND_LABEL,
  DB_SECRET_OF_LABEL,
  SECRET_CONTENT_HASH_LABEL,
  dbSecretFamily,
  parseDbSecretName,
  pickUrlSecret,
  staleUrlSecrets,
  type DbSecretKind,
  type DbUrlKind,
  type ListedSecret,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';

/**
 * An app's managed-Postgres URL secrets (`db.inject`, rotation, the failover
 * repoint; the app side is `manageddb-app-wire.ts`). A URL secret is addressed by its content (@swarmy/core
 * `manageddb-url-secret.ts`): one that already holds this exact URL is
 * reused, else the next free version is minted, so a URL naming a new host or
 * a new password always gets a new name and an app never mounts a stale one.
 * The value rides the authenticated WS into the Docker API, never persisted.
 */

const DISPATCH_TIMEOUT_MS = 60_000;

/** Labels of every managed-DB secret (`swarmy.secret.version` = its `__v<n>`). */
export function dbSecretLabels(stack: string, cluster: string, kind: DbSecretKind, version: number, host?: string): Record<string, string> {
  return {
    'swarmy.managed': 'true',
    'swarmy.db.cluster': cluster,
    [DB_SECRET_OF_LABEL]: `${stack}/${cluster}`,
    [DB_SECRET_KIND_LABEL]: kind,
    'swarmy.secret.version': String(version),
    ...(host ? { [DB_SECRET_HOST_LABEL]: host } : {}),
  };
}

/** The swarm's secrets (names + labels, never values). Throws when they can't be listed. */
export async function listDbSecrets(ctx: OrgContext, nodeId: string): Promise<ListedSecret[]> {
  try {
    const r = await ctx.hub.dispatch<{ secrets?: Array<{ name: string; labels?: Record<string, string> }> }>(nodeId, 'secret.list', {});
    return (r?.secrets ?? []).map((s) => ({ name: s.name, labels: s.labels ?? {} }));
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export interface UrlSecretMint {
  stack: string;
  cluster: string;
  kind: DbUrlKind;
  /** The full URL (holds the password). */
  value: string;
  host: string;
  /** The password secret's version: a first mint is named after it. */
  floor: number;
}

/** The URL secret holding `m.value`: reused when one already does, else minted. `listed` learns what is created. */
export async function mintDbUrlSecret(ctx: OrgContext, nodeId: string, m: UrlSecretMint, listed: ListedSecret[]): Promise<string> {
  const family = dbSecretFamily(m.stack, m.cluster, m.kind);
  const hash = createHash('sha256').update(m.value, 'utf8').digest('hex');
  for (let attempt = 0; ; attempt++) {
    const pick = pickUrlSecret({ family, hash, floor: m.floor, existing: listed });
    if (!pick.create) return pick.name;
    const version = parseDbSecretName(pick.name)?.version ?? 1;
    try {
      await ctx.hub.dispatch(
        nodeId,
        'secret.create',
        { name: pick.name, dataB64: Buffer.from(m.value, 'utf8').toString('base64'), labels: dbSecretLabels(m.stack, m.cluster, m.kind, version, m.host) },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
      listed.push({ name: pick.name, labels: { [DB_SECRET_HOST_LABEL]: m.host, [SECRET_CONTENT_HASH_LABEL]: hash } });
      return pick.name;
    } catch (e) {
      // Taken meanwhile (a concurrent connect): the next free version.
      if (attempt >= 2 || !/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw mapDispatchError(e);
      listed.push({ name: pick.name, labels: {} });
    }
  }
}

/** Remove the cluster's URL secrets of `kinds` not in `keep`, best effort (Docker refuses one still mounted). */
export async function retireUrlSecrets(
  ctx: OrgContext,
  nodeId: string,
  r: { stack: string; cluster: string; kinds: readonly DbUrlKind[]; keep: ReadonlySet<string>; listed?: ListedSecret[] },
): Promise<string[]> {
  const listed = r.listed ?? (await listDbSecrets(ctx, nodeId).catch(() => null));
  if (!listed) return [];
  const removed: string[] = [];
  for (const name of staleUrlSecrets({ ...r, listed })) {
    const ok = await ctx.hub.dispatch(nodeId, 'secret.remove', { name }).then(() => true, () => false);
    if (ok) removed.push(name);
  }
  return removed;
}
