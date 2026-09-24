/**
 * Where RUM data lives for an org: the observability ClickHouse (same DSN and
 * database as otel_*; analytics rows + the replay index) and swarmy object
 * storage (Garage bucket `swarmy-rum-replays`; replay event chunks).
 *
 * Nothing new is deployed: RUM needs the org's observability store on, and
 * replay additionally needs object storage on. When either is off the ingest
 * answers 503 and the UI says which switch to flip.
 *
 * Env overrides (dev / e2e, and operators pointing at their own stores):
 *   SWARMY_RUM_CLICKHOUSE_DSN  http://user:pw@host:8123/db
 *   SWARMY_RUM_S3_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY
 */
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import {
  RUM_DDL,
  RUM_REPLAY_BUCKET,
  clickhouseClient,
  parseClickhouseDsn,
  s3BlobStore,
  type BlobStore,
  type ClickhouseClient,
} from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { observabilityConfigRepo } from '../observability-config.repo';
import { objectStoreState, provisionSystemBucketKey } from '../buckets.service';
import { orgSingleton, type KvScope } from '../kv-repo';

export const RUM_S3_KEY_NAME = 'swarmy-rum';

interface RumStoreDoc {
  accessKeyId: string | null;
  /** Vault-sealed (SWARMY_SECRET_KEY) — same treatment as the observability DSN. */
  secretEnc: string | null;
  bucket: string;
  region: string;
  endpoint: string;
}

const rumStoreRepo = orgSingleton<RumStoreDoc>('rum', () => ({
  accessKeyId: null,
  secretEnc: null,
  bucket: RUM_REPLAY_BUCKET,
  region: 'garage',
  endpoint: '',
}));

function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch {
    return blob;
  }
}

const ddlDone = new Set<string>();

async function withSchema(client: ClickhouseClient, key: string): Promise<ClickhouseClient> {
  if (!ddlDone.has(key)) {
    for (const ddl of RUM_DDL) await client.exec(ddl);
    ddlDone.add(key);
  }
  return client;
}

/** The org's ClickHouse (tables ensured), or null when observability is off. */
export async function rumClickhouse(scope: KvScope, orgId: string): Promise<ClickhouseClient | null> {
  const override = process.env.SWARMY_RUM_CLICKHOUSE_DSN;
  let dsn: string | null = override || null;
  if (!dsn) {
    const row = await observabilityConfigRepo.find(scope, orgId).catch(() => null);
    if (!row || !row.enabled || !row.clickhouseDsn) return null;
    dsn = safeDecrypt(row.clickhouseDsn);
  }
  return withSchema(clickhouseClient(parseClickhouseDsn(dsn)), dsn);
}

function envBlobStore(): BlobStore | null {
  const e = process.env;
  if (!e.SWARMY_RUM_S3_ENDPOINT || !e.SWARMY_RUM_S3_ACCESS_KEY_ID || !e.SWARMY_RUM_S3_SECRET_ACCESS_KEY) return null;
  return s3BlobStore({
    endpoint: e.SWARMY_RUM_S3_ENDPOINT,
    region: e.SWARMY_RUM_S3_REGION || 'garage',
    bucket: e.SWARMY_RUM_S3_BUCKET || RUM_REPLAY_BUCKET,
    accessKeyId: e.SWARMY_RUM_S3_ACCESS_KEY_ID,
    secretAccessKey: e.SWARMY_RUM_S3_SECRET_ACCESS_KEY,
  });
}

const provisioning = new Map<string, Promise<BlobStore | null>>();

/**
 * The org's replay blob store. Provisions the bucket + a bucket-scoped key on
 * first use (needs an OrgContext for the Garage admin path); `null` when
 * object storage is off.
 */
export async function rumBlobStore(ctx: OrgContext): Promise<BlobStore | null> {
  const env = envBlobStore();
  if (env) return env;
  const orgId = ctx.activeOrgId;
  const doc = await rumStoreRepo.find(ctx, orgId).catch(() => null);
  if (doc?.accessKeyId && doc.secretEnc && doc.endpoint) {
    return s3BlobStore({
      endpoint: doc.endpoint,
      region: doc.region,
      bucket: doc.bucket,
      accessKeyId: doc.accessKeyId,
      secretAccessKey: safeDecrypt(doc.secretEnc),
    });
  }
  const pending = provisioning.get(orgId);
  if (pending) return pending;
  const p = (async () => {
    const state = await objectStoreState(ctx);
    if (!state.enabled) return null;
    const cred = await provisionSystemBucketKey(ctx, { bucket: RUM_REPLAY_BUCKET, keyName: RUM_S3_KEY_NAME });
    await rumStoreRepo.update(ctx, orgId, {
      accessKeyId: cred.accessKeyId,
      secretEnc: encryptSecret(cred.secretAccessKey),
      bucket: cred.bucket,
      region: cred.region,
      endpoint: cred.endpoint,
    });
    return s3BlobStore({
      endpoint: cred.endpoint,
      region: cred.region,
      bucket: cred.bucket,
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
    });
  })().finally(() => provisioning.delete(orgId));
  provisioning.set(orgId, p);
  return p;
}

/** Store availability for the settings UI (no provisioning side effects). */
export async function rumStoreStatus(ctx: OrgContext): Promise<{ analytics: boolean; replay: boolean }> {
  const ch = process.env.SWARMY_RUM_CLICKHOUSE_DSN
    ? true
    : Boolean((await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null))?.enabled);
  const blobs = envBlobStore() ? true : (await objectStoreState(ctx).catch(() => ({ enabled: false }))).enabled;
  return { analytics: ch, replay: ch && blobs };
}
