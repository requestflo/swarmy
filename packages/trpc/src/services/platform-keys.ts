/**
 * Platform-owned object-storage keys (QA-081) — PURE.
 *
 * swarmy mints Garage access keys for its own consumers (presigned links, the
 * controller's Litestream replica, build logs, session replay, edge cert sync,
 * the mesh control plane's Litestream, the native restic backup target — which
 * volume/DB backups, WAL shipping and controller backups all ride on). Garage
 * keys carry no metadata beyond a name, so the NAME is the mark: every
 * platform key is named `swarmy-<purpose>`, and the `swarmy-` prefix is
 * reserved — a person can't mint a key under it (`assertUserKeyName`).
 *
 * Rules the rest of the code keeps:
 *  - one key per purpose: a consumer that mints a replacement retires the
 *    same-named keys it superseded once the new one is persisted
 *    (`retireSupersededSystemKeys`), and storage-reconcile garbage-collects
 *    whatever is left (`planPlatformKeyGc`);
 *  - the buckets UI shows them as "Used by swarmy" with no delete/rotate, and
 *    the API refuses both with FORBIDDEN.
 *
 * Names are literals here (not imported from the consumer modules) so this
 * module stays import-free; `platform-keys.test.ts` pins each consumer's
 * constant to this table.
 */

/** Every platform key name starts with this; user-minted keys may not. */
export const PLATFORM_KEY_PREFIX = 'swarmy-';

/** Attach keys (`swarmy-attach-<svc>-<bucket>`) belong to the user's app, not the platform. */
export const ATTACH_KEY_PREFIX = 'swarmy-attach-';

/** A key minted less than this long ago is never garbage-collected (it may not be persisted yet). */
export const PLATFORM_KEY_GRACE_MS = 10 * 60_000;

export type PlatformKeyPurposeId =
  | 'presign'
  | 'control-litestream'
  | 'build-logs'
  | 'rum'
  | 'edge-certs'
  | 'edge-certs-purge'
  | 'mesh-litestream'
  | 'backups';

export interface PlatformKeyPurpose {
  id: PlatformKeyPurposeId;
  /** Exact key name, or a name prefix (one key per cluster). */
  name?: string;
  prefix?: string;
  /** Plain words for the UI ("Used by swarmy · <usedBy>"). */
  usedBy: string;
}

export const PLATFORM_KEY_PURPOSES: readonly PlatformKeyPurpose[] = [
  { id: 'presign', name: 'swarmy-presign', usedBy: 'Signs share and download links' },
  {
    id: 'control-litestream',
    name: 'swarmy-control-litestream',
    usedBy: 'Controller database replication',
  },
  { id: 'build-logs', name: 'swarmy-build-logs', usedBy: 'Build log archive' },
  { id: 'rum', name: 'swarmy-rum', usedBy: 'Session replay storage' },
  { id: 'edge-certs', name: 'swarmy-edge-certs', usedBy: 'Edge TLS certificate sync' },
  { id: 'edge-certs-purge', name: 'swarmy-edge-certs-purge', usedBy: 'Edge certificate clean-up' },
  {
    id: 'mesh-litestream',
    prefix: 'swarmy-mesh-litestream-',
    usedBy: 'Private network control plane backup',
  },
  {
    id: 'backups',
    name: 'swarmy-object-storage-restic',
    usedBy: 'Backups (volumes, databases, WAL archive, controller)',
  },
];

/** The platform purpose a key name belongs to, or null for a user/attach key. */
export function platformKeyPurpose(name: string | null | undefined): PlatformKeyPurpose | null {
  if (!name) return null;
  for (const p of PLATFORM_KEY_PURPOSES) {
    if (p.name !== undefined && name === p.name) return p;
    if (p.prefix !== undefined && name.startsWith(p.prefix) && name.length > p.prefix.length)
      return p;
  }
  return null;
}

/**
 * Why a person may not mint a key under this name (null = fine). The
 * `swarmy-` prefix is the platform's mark; letting a user take it would make
 * their key undeletable and let it be garbage-collected as a leftover.
 */
export function reservedKeyNameReason(name: string): string | null {
  return name.trim().toLowerCase().startsWith(PLATFORM_KEY_PREFIX)
    ? `key names starting with "${PLATFORM_KEY_PREFIX}" are reserved for keys swarmy manages — pick another name`
    : null;
}

export interface GcKey {
  id: string;
  name: string;
  /** Garage v2 reports a creation time; v1 does not. */
  createdAt?: number;
}

/**
 * Which platform keys to delete. A key goes only when ALL hold:
 *  - it is a platform key (by name) whose purpose's in-use set is KNOWN
 *    (`inUse[purpose]` is an array — null/undefined means "couldn't tell",
 *    and unknown is never unused);
 *  - it is not in that set;
 *  - it is past the grace window (not minted by this process in the last
 *    {@link PLATFORM_KEY_GRACE_MS}, and not created that recently per Garage),
 *    so a key between mint and persist is never taken.
 */
export function planPlatformKeyGc(
  keys: readonly GcKey[],
  inUse: Partial<Record<PlatformKeyPurposeId, readonly string[] | null>>,
  recentMints: ReadonlyMap<string, number>,
  now: number,
): GcKey[] {
  const out: GcKey[] = [];
  for (const k of keys) {
    const p = platformKeyPurpose(k.name);
    if (!p) continue;
    const used = inUse[p.id];
    if (!Array.isArray(used)) continue;
    if (used.includes(k.id)) continue;
    const minted = recentMints.get(k.id);
    if (minted !== undefined && now - minted < PLATFORM_KEY_GRACE_MS) continue;
    if (k.createdAt !== undefined && now - k.createdAt < PLATFORM_KEY_GRACE_MS) continue;
    out.push(k);
  }
  return out;
}
