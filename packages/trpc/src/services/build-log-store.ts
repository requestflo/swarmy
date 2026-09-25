/**
 * Durable build logs (QA-056). The live tail runs through the in-memory
 * `buildLogBus`, which a controller restart empties, so every finished build
 * later read "No logs captured". When a build finishes, its log is written:
 *  - to the controller's data dir (`<SWARMY_DATA_DIR>/build-logs/<ref>.ndjson`),
 *    always, which survives a restart on the same node;
 *  - to the org's object storage (the `swarmy-build-logs` Garage bucket, with a
 *    bucket-scoped key provisioned on first use) when object storage is on,
 *    which survives the controller moving to another node.
 * A read falls back in that order when the bus has nothing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import { s3BlobStore, type BlobStore } from '@swarmy/rum';
import type { OrgContext } from '../context';
import { objectStoreState, provisionSystemBucketKey } from './buckets.service';
import { buildLogBus } from './build-log-bus';
import { orgSingleton } from './kv-repo';

export const BUILD_LOG_BUCKET = 'swarmy-build-logs';
const KEY_NAME = 'swarmy-build-logs';

export interface StoredLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

interface BuildLogStoreDoc {
  accessKeyId: string | null;
  secretEnc: string | null;
  bucket: string;
  region: string;
  endpoint: string;
}
const storeRepo = orgSingleton<BuildLogStoreDoc>('build-logs', () => ({
  accessKeyId: null,
  secretEnc: null,
  bucket: BUILD_LOG_BUCKET,
  region: 'garage',
  endpoint: '',
}));

/** PURE — NDJSON for a log, and back. Tolerant of a torn last line. */
export function encodeLog(lines: readonly StoredLogLine[]): string {
  return lines.map((l) => JSON.stringify({ seq: l.seq, stream: l.stream, message: l.message })).join('\n') + (lines.length ? '\n' : '');
}
export function decodeLog(text: string): StoredLogLine[] {
  const out: StoredLogLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw) as StoredLogLine;
      if (typeof o.message === 'string') out.push({ seq: Number(o.seq) || 0, stream: o.stream === 'stderr' ? 'stderr' : 'stdout', message: o.message });
    } catch {
      // a torn line: skip
    }
  }
  return out;
}

/** Only safe file/object names (logsRef is a command id). */
function safeRef(ref: string): string | null {
  return /^[\w.-]{1,128}$/.test(ref) ? ref : null;
}

export function localLogPath(ref: string, dataDir = process.env.SWARMY_DATA_DIR): string | null {
  const r = safeRef(ref);
  return r && dataDir ? path.join(dataDir, 'build-logs', `${r}.ndjson`) : null;
}

async function blobStore(ctx: OrgContext, provision: boolean): Promise<BlobStore | null> {
  const doc = await storeRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  if (doc?.accessKeyId && doc.secretEnc && doc.endpoint) {
    return s3BlobStore({
      endpoint: doc.endpoint,
      region: doc.region,
      bucket: doc.bucket,
      accessKeyId: doc.accessKeyId,
      secretAccessKey: decryptSecret(doc.secretEnc),
    });
  }
  if (!provision) return null;
  const state = await objectStoreState(ctx).catch(() => ({ enabled: false }));
  if (!state.enabled) return null;
  const cred = await provisionSystemBucketKey(ctx, { bucket: BUILD_LOG_BUCKET, keyName: KEY_NAME });
  await storeRepo.update(ctx, ctx.activeOrgId, {
    accessKeyId: cred.accessKeyId,
    secretEnc: encryptSecret(cred.secretAccessKey),
    bucket: cred.bucket,
    region: cred.region,
    endpoint: cred.endpoint,
  });
  return s3BlobStore({ endpoint: cred.endpoint, region: cred.region, bucket: cred.bucket, accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey });
}

const objectKey = (orgId: string, ref: string) => `${orgId}/${ref}.ndjson`;

/** Persist a finished build's log (best-effort: never fails the build). */
export async function persistBuildLog(ctx: OrgContext, ref: string): Promise<{ local: boolean; object: boolean }> {
  const r = safeRef(ref);
  if (!r) return { local: false, object: false };
  const lines = buildLogBus.snapshot(r).lines.map((l) => ({ seq: l.seq, stream: l.stream, message: l.message }));
  if (!lines.length) return { local: false, object: false };
  const body = encodeLog(lines);
  let local = false;
  let object = false;
  const file = localLogPath(r);
  if (file) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, { mode: 0o600 });
      local = true;
    } catch {
      // disk trouble: the object copy may still land
    }
  }
  try {
    const store = await blobStore(ctx, true);
    if (store) {
      await store.put(objectKey(ctx.activeOrgId, r), new TextEncoder().encode(body), 'application/x-ndjson');
      object = true;
    }
  } catch {
    // object storage down: the local copy stands
  }
  return { local, object };
}

/** A finished build's stored log: the local file, else object storage; [] when neither has it. */
export async function readStoredBuildLog(ctx: OrgContext, ref: string): Promise<StoredLogLine[]> {
  const r = safeRef(ref);
  if (!r) return [];
  const file = localLogPath(r);
  if (file) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text) return decodeLog(text);
  }
  try {
    const store = await blobStore(ctx, false);
    const bytes = store ? await store.get(objectKey(ctx.activeOrgId, r)) : null;
    if (bytes) return decodeLog(new TextDecoder().decode(bytes));
  } catch {
    // unavailable: nothing stored we can reach
  }
  return [];
}
