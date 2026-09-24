/**
 * StorageCluster + BucketAccess repositories — swarm-kv (P4 slice 2).
 *
 *  - `storage/<orgId>`: the org's replicated object store (Garage) — driver,
 *    replication, region, members, per-member layout, the engine image it runs
 *    and the vault-encrypted `*Ref` credentials (the whole document is sealed
 *    in raft too). Members and layout stay in the document: membership is the
 *    operator's desired set and changes at human speed; a layout entry is
 *    written once per member (its capacity and, when first observed, its
 *    Garage node id), never per tick.
 *  - `bucket-acl/<orgId>`: every bucket's reachability (INTERNAL/MESH/PUBLIC)
 *    in one document; Garage bucket ids are 64 hex chars, too long for a
 *    config name of their own.
 *
 * The engine-upgrade run is run state: it lives in the controller store
 * (`OperationRun`, kind "storage.engineUpgrade"), never here.
 */
import { orgSingleton, type KvRow, type KvScope } from './kv-repo';

export type StorageClusterDriverEnum = 'GARAGE' | 'MINIO' | 'NONE';

export interface StorageClusterDoc {
  driver: StorageClusterDriverEnum;
  enabled: boolean;
  replicationFactor: number;
  region: string;
  memberNodeIds: string[];
  layout: Record<string, unknown>;
  rpcSecretRef: string | null;
  adminTokenRef: string | null;
  accessKeyRef: string | null;
  secretKeyRef: string | null;
  /** Public S3 hostname for PUBLIC buckets (null = derived from the dashboard domain). */
  publicS3Domain: string | null;
  /** Garage image this store RUNS (null = legacy v1.0.1). Changed only by an engine upgrade. */
  engineImage: string | null;
}

export type StorageClusterRow = KvRow<StorageClusterDoc>;

const DEFAULTS = (): StorageClusterDoc => ({
  driver: 'NONE',
  enabled: false,
  replicationFactor: 3,
  region: 'swarmy',
  memberNodeIds: [],
  layout: {},
  rpcSecretRef: null,
  adminTokenRef: null,
  accessKeyRef: null,
  secretKeyRef: null,
  publicS3Domain: null,
  engineImage: null,
});

/**
 * `find` is null until the operator first configured the store — callers
 * treat that as "object storage was never set up" (the old missing row).
 */
export const storageClusterRepo = orgSingleton<StorageClusterDoc>('storage', DEFAULTS);

// ── BucketAccess ──────────────────────────────────────────────────────────────

interface BucketAclDoc {
  /** Garage bucket id → its alias when set + the mode. No entry = INTERNAL. */
  buckets: Record<string, { bucketName: string; mode: string }>;
}

export interface BucketAccessRow {
  orgId: string;
  bucketId: string;
  bucketName: string;
  mode: string;
}

const acl = orgSingleton<BucketAclDoc>('bucket-acl', () => ({ buckets: {} }));

export const bucketAccessRepo = {
  async list(scope: KvScope, orgId: string): Promise<BucketAccessRow[]> {
    const doc = await acl.find(scope, orgId);
    return Object.entries(doc?.buckets ?? {})
      .map(([bucketId, b]) => ({ orgId, bucketId, bucketName: b.bucketName, mode: b.mode }))
      .sort((a, b) => (a.bucketName < b.bucketName ? -1 : 1));
  },
  async find(scope: KvScope, orgId: string, bucketId: string): Promise<BucketAccessRow | null> {
    return (await this.list(scope, orgId)).find((r) => r.bucketId === bucketId) ?? null;
  },
  /** Buckets reachable beyond the cluster (MESH or PUBLIC). */
  async countExposed(scope: KvScope, orgId: string): Promise<number> {
    return (await this.list(scope, orgId)).filter((r) => r.mode === 'MESH' || r.mode === 'PUBLIC').length;
  },
  async set(scope: KvScope, orgId: string, bucketId: string, bucketName: string, mode: string): Promise<void> {
    await acl.update(scope, orgId, (cur) => ({ buckets: { ...cur.buckets, [bucketId]: { bucketName, mode } } }));
  },
  /** Forget a bucket (back to INTERNAL). No write when it had no entry. */
  async remove(scope: KvScope, orgId: string, bucketId: string): Promise<void> {
    await acl.update(scope, orgId, (cur) => {
      if (!cur.buckets[bucketId]) return undefined;
      const { [bucketId]: _drop, ...rest } = cur.buckets;
      return { buckets: rest };
    });
  },
};
