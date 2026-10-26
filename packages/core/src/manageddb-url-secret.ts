/**
 * Which Docker secret holds an app's managed-Postgres connection URL. PURE.
 *
 * A URL secret's content is `postgres://postgres:<password>@<host>:<port>/<db>`,
 * and Docker secrets are immutable: when the host changes (a failover, a
 * planned switch-over) or the password does (a rotation), the URL needs a NEW
 * name. So a URL secret is addressed by its content:
 *
 *   - an existing version whose content hash (`swarmy.content.sha256`, stamped
 *     by the agent on every secret it creates) matches is reused, so every app
 *     wired the same way shares one secret;
 *   - otherwise the next free version of the family is minted, never below
 *     the password's version (the name a first connect has always used).
 *
 * The version is no longer tied to the password version, so a repoint's
 * version can never collide with a later rotation's. Old versions go once
 * nothing mounts them ({@link staleUrlSecrets}; Docker refuses one in use).
 */
import { dbSecretFamily, parseDbSecretName, type DbSecretKind } from './manageddb-pg';

/** sha256 of a secret's content, stamped by the agent (`swarmres.ts`) on every secret it creates. */
export const SECRET_CONTENT_HASH_LABEL = 'swarmy.content.sha256';
/** On a URL secret: the host its URL names (Docker truth, for whoever inspects it). */
export const DB_SECRET_HOST_LABEL = 'swarmy.db.secret.host';

export type DbUrlKind = Extract<DbSecretKind, 'url' | 'ro-url' | 'pool-url'>;
export const DB_URL_KINDS: readonly DbUrlKind[] = ['url', 'ro-url', 'pool-url'];

/** A Docker secret as `secret.list` reports it (never its value). */
export interface ListedSecret {
  name: string;
  labels: Record<string, string>;
}

export interface UrlSecretPick {
  name: string;
  /** false: an existing version already holds exactly this content. */
  create: boolean;
}

/** The secret for content `hash` in `family`: a matching version, else the next free one (≥ `floor`). */
export function pickUrlSecret(i: { family: string; hash: string; floor: number; existing: readonly ListedSecret[] }): UrlSecretPick {
  let top = 0;
  let match: { name: string; version: number } | null = null;
  for (const s of i.existing) {
    const p = parseDbSecretName(s.name);
    if (!p || p.family !== i.family) continue;
    top = Math.max(top, p.version);
    if (s.labels[SECRET_CONTENT_HASH_LABEL] === i.hash && (!match || p.version > match.version)) match = { name: s.name, version: p.version };
  }
  if (match) return { name: match.name, create: false };
  const version = Math.max(Math.max(1, i.floor), top + 1);
  return { name: `${i.family}__v${version}`, create: true };
}

/**
 * The cluster's URL secrets of `kinds` that may go: every listed version not in
 * `keep`. Docker refuses to remove one a service still mounts, so callers
 * remove best-effort and an app that didn't move keeps its secret.
 */
export function staleUrlSecrets(i: {
  stack: string;
  cluster: string;
  kinds: readonly DbUrlKind[];
  listed: readonly ListedSecret[];
  keep: ReadonlySet<string>;
}): string[] {
  const families = new Set(i.kinds.map((k) => dbSecretFamily(i.stack, i.cluster, k)));
  return i.listed
    .filter((s) => !i.keep.has(s.name) && families.has(parseDbSecretName(s.name)?.family ?? ''))
    .map((s) => s.name)
    .sort();
}
