/**
 * Per-bucket S3 reachability — who can reach one bucket's S3 API from where.
 *
 *   INTERNAL (default, no row) — in-cluster only: apps on the swarmy overlay,
 *     backups, the offsite mirror. Nothing is routed from outside.
 *   MESH   — plus mesh peers: http://<edge mesh IP>:3900/<bucket>, source-
 *     restricted to the mesh CIDR (WireGuard encrypts the hop).
 *   PUBLIC — plus the internet: https://<public S3 domain>/<bucket> with a real
 *     certificate on every edge (and mesh peers, as above).
 *
 * Enforcement is at the Caddy edge: a bucket-path allowlist in front of Garage
 * (see `buildPublicObjectStorageSite` / `buildMeshObjectStorageSite`), so an
 * INTERNAL bucket is never routable. Garage still demands SigV4 — a key, or a
 * presigned signature — on every request: reachable is not anonymous.
 *
 * Exposure is swarmy's own access-control state (DB `bucket_access`), like
 * mesh ACLs; the bucket itself stays Garage truth.
 */
import type { ObjectStorageEdge } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { getBucket, objectStoreState } from './buckets.service';
import { OBJECT_STORAGE_MESH_PORT } from './ingress-controller';

export type BucketAccessMode = 'INTERNAL' | 'MESH' | 'PUBLIC';
export const BUCKET_ACCESS_MODES: readonly BucketAccessMode[] = ['INTERNAL', 'MESH', 'PUBLIC'];

/** Garage S3 on the swarmy overlay, as the edges dial it. */
export const GARAGE_S3_UPSTREAM = 'swarmy-garage:3900';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Default public S3 hostname from the dashboard's: `swarmy.x` → `s3.x` (the
 * installer's `swarmy.<ip>.sslip.io` becomes `s3.<ip>.sslip.io`, which resolves
 * the same way), anything else → `s3.<dashboard>`. None without a dashboard
 * domain — then PUBLIC needs one set explicitly. Pure.
 */
export function derivePublicS3Domain(dashboardDomain: string | null | undefined): string | undefined {
  const d = dashboardDomain?.trim().toLowerCase();
  if (!d) return undefined;
  return d.startsWith('swarmy.') ? `s3.${d.slice('swarmy.'.length)}` : `s3.${d}`;
}

/** Validate an operator-supplied public S3 hostname (null clears it). Pure. */
export function normalizePublicS3Domain(input: string | null): string | null {
  if (input === null) return null;
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (!d) return null;
  if (!HOSTNAME.test(d)) throw commandRejected(`"${input}" is not a valid hostname`);
  return d;
}

export interface BucketAccessRow {
  bucketName: string;
  mode: string;
}

/**
 * The edge render input for object storage, or undefined when nothing is
 * exposed (no extra site, no extra port). Pure over the rows.
 */
export function buildObjectStorageEdge(input: {
  rows: readonly BucketAccessRow[];
  publicDomain: string | undefined;
}): ObjectStorageEdge | undefined {
  const publicBuckets = input.rows.filter((r) => r.mode === 'PUBLIC').map((r) => r.bucketName).sort();
  const meshBuckets = input.rows.filter((r) => r.mode === 'MESH').map((r) => r.bucketName).sort();
  if (publicBuckets.length === 0 && meshBuckets.length === 0) return undefined;
  return {
    upstream: GARAGE_S3_UPSTREAM,
    publicDomain: input.publicDomain,
    publicBuckets,
    meshBuckets,
    meshPort: OBJECT_STORAGE_MESH_PORT,
    meshCidr: '100.64.0.0/10',
  };
}

async function clusterRow(ctx: OrgContext) {
  return ctx.db.storageCluster.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { publicS3Domain: true },
  });
}

/** The effective public S3 hostname: the operator's, else derived from the dashboard's. */
export async function publicS3DomainFor(
  ctx: OrgContext,
  dashboardDomain: string | null | undefined,
): Promise<{ domain: string | undefined; custom: boolean }> {
  const row = await clusterRow(ctx).catch(() => null);
  if (row?.publicS3Domain) return { domain: row.publicS3Domain, custom: true };
  return { domain: derivePublicS3Domain(dashboardDomain), custom: false };
}

/** Edge render input (called by the ingress config loader). */
export async function objectStorageEdgeFor(
  ctx: OrgContext,
  dashboardDomain: string | null | undefined,
): Promise<ObjectStorageEdge | undefined> {
  const store = await objectStoreState(ctx).catch(() => ({ enabled: false as const }));
  if (!store.enabled) return undefined;
  // Fail closed: unreadable exposure ⇒ nothing routed (never "everything").
  let rows: BucketAccessRow[] = [];
  try {
    rows = await ctx.db.bucketAccess.findMany({
      where: { orgId: ctx.activeOrgId },
      select: { bucketName: true, mode: true },
    });
  } catch {
    rows = [];
  }
  return buildObjectStorageEdge({ rows, publicDomain: (await publicS3DomainFor(ctx, dashboardDomain)).domain });
}

export async function bucketAccessMode(ctx: OrgContext, bucketId: string): Promise<BucketAccessMode> {
  const row = await ctx.db.bucketAccess.findUnique({
    where: { orgId_bucketId: { orgId: ctx.activeOrgId, bucketId } },
    select: { mode: true },
  });
  return (row?.mode as BucketAccessMode | undefined) ?? 'INTERNAL';
}

/** Whether any bucket needs the mesh listener (MESH or PUBLIC). */
async function meshListenerNeeded(ctx: OrgContext): Promise<boolean> {
  const n = await ctx.db.bucketAccess.count({
    where: { orgId: ctx.activeOrgId, mode: { in: ['MESH', 'PUBLIC'] } },
  });
  return n > 0;
}

export interface SetBucketAccessResult {
  bucketId: string;
  bucket: string;
  mode: BucketAccessMode;
  /** The edge's published ports change (mesh listener on/off) — the edge redeploys. */
  edgePortsChanged: boolean;
}

/**
 * Set one bucket's reachability. DB + audit only; the caller re-renders the
 * edge (and redeploys it when `edgePortsChanged`). PUBLIC is refused while no
 * public hostname is known — the edge would have nowhere to serve it.
 */
export async function setBucketAccess(
  ctx: OrgContext,
  input: { bucketId: string; mode: BucketAccessMode; dashboardDomain: string | null | undefined },
): Promise<SetBucketAccessResult> {
  if (!BUCKET_ACCESS_MODES.includes(input.mode)) throw commandRejected(`unknown access mode "${input.mode}"`);
  const store = await objectStoreState(ctx);
  if (!store.enabled) throw notFound('object storage', ctx.activeOrgId);
  // Proves the bucket exists in THIS org's store and gives its current name.
  const bucket = await getBucket(ctx, input.bucketId);
  if (input.mode === 'PUBLIC' && !(await publicS3DomainFor(ctx, input.dashboardDomain)).domain) {
    throw commandRejected(
      'set a public S3 domain first (Buckets → Access) — there is no dashboard domain to derive one from',
    );
  }
  const before = await meshListenerNeeded(ctx);
  const previous = await bucketAccessMode(ctx, bucket.id);
  if (input.mode === 'INTERNAL') {
    await ctx.db.bucketAccess.deleteMany({ where: { orgId: ctx.activeOrgId, bucketId: bucket.id } });
  } else {
    await ctx.db.bucketAccess.upsert({
      where: { orgId_bucketId: { orgId: ctx.activeOrgId, bucketId: bucket.id } },
      create: { orgId: ctx.activeOrgId, bucketId: bucket.id, bucketName: bucket.name, mode: input.mode },
      update: { bucketName: bucket.name, mode: input.mode },
    });
  }
  const after = await meshListenerNeeded(ctx);
  await writeAudit(ctx, {
    action: 'buckets.setAccess',
    targetType: 'bucket',
    targetId: bucket.id,
    metadata: { bucket: bucket.name, from: previous, to: input.mode },
  });
  return { bucketId: bucket.id, bucket: bucket.name, mode: input.mode, edgePortsChanged: before !== after };
}

/** Set (or clear, with null) the org's public S3 hostname. */
export async function setPublicS3Domain(ctx: OrgContext, domain: string | null): Promise<string | null> {
  const value = normalizePublicS3Domain(domain);
  await ctx.db.storageCluster.update({ where: { orgId: ctx.activeOrgId }, data: { publicS3Domain: value } });
  await writeAudit(ctx, {
    action: 'buckets.setPublicDomain',
    targetType: 'storageCluster',
    targetId: ctx.activeOrgId,
    metadata: { domain: value },
  });
  return value;
}

/** Where a bucket's S3 API is reachable from, for its current mode. Pure. */
export function bucketEndpoints(input: {
  bucket: string;
  mode: BucketAccessMode;
  publicDomain: string | undefined;
  edgeMeshIps: readonly string[];
}): { internal: string; mesh: string[]; public: string | null } {
  const reachesMesh = input.mode !== 'INTERNAL';
  return {
    internal: `http://${GARAGE_S3_UPSTREAM}/${input.bucket}`,
    mesh: reachesMesh
      ? [...input.edgeMeshIps].sort().map((ip) => `http://${ip}:${OBJECT_STORAGE_MESH_PORT}/${input.bucket}`)
      : [],
    public: input.mode === 'PUBLIC' && input.publicDomain ? `https://${input.publicDomain}/${input.bucket}` : null,
  };
}
