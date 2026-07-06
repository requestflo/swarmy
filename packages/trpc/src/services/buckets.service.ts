/**
 * Object storage buckets — Garage bucket/key CRUD, quotas, usage, service attach
 * (slice A4, platform buildout).
 *
 * All bucket/key state lives IN Garage (the admin API is the source of truth) —
 * no Prisma model. The controller reaches the admin API the same way the
 * replicated-store slice does: it never talks to the overlay itself, it
 * dispatches to an agent. Concretely each admin call is a `container.runOnce`
 * curl on a storage member node (host network → the ingress-published admin
 * port on 127.0.0.1), with the admin token riding as one-shot container env —
 * mirroring the agent-side fetch in `handlers/storage.ts#applyStorageNode`.
 *
 * Attach mirrors `manageddb.service.ts#injectConnection` / cache attach:
 * a bucket-scoped Garage key is minted, its secret becomes a Docker secret
 * (`secret.create`), and the app service is redeployed with `S3_*` env + the
 * secret ref + `swarmy.s3.*` labels (Docker-truth for the wiring).
 */
import {
  buildInventory,
  STACK_LABEL,
  type AttachBucketInput,
  type BucketAttachResult,
  type BucketAttachmentView,
  type BucketDetailView,
  type BucketKeyCreatedView,
  type BucketKeysView,
  type BucketPermissionsView,
  type BucketQuotaView,
  type BucketsOverview,
  type BucketSummaryView,
  type CreateBucketInput,
  type GrantKeyOnBucketInput,
  type InvService,
  type SetBucketQuotaInput,
  type SetBucketWebsiteInput,
  type StorageAccessKeyView,
} from '@swarmy/core';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { RunOnceResult, ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { GARAGE_ADMIN_PORT, GARAGE_S3_PORT } from './garage-render';
import { MAX_PRESIGN_EXPIRES_SECONDS, presignS3Url } from './s3-presign';
import { parsePhysicalSecretName, physicalSecretName, secretRefsFor } from './secretsMgr.service';

// Keep in lockstep with replicatedStore.service.ts (same deployment).
const STORE_SERVICE_NAME = 'swarmy-garage';
/** Pinned curl image for one-shot admin calls (no jq — parsing is controller-side). */
export const CURL_IMAGE = 'curlimages/curl:8.10.1';
const DISPATCH_TIMEOUT_MS = 45_000;

// ── Docker-truth labels stamped on ATTACHED app services ─────────────────────
/** Bucket name the service is wired to. */
export const S3_BUCKET_LABEL = 'swarmy.s3.bucket';
/** The bucket-scoped Garage access key id minted for the service. */
export const S3_KEY_LABEL = 'swarmy.s3.key';
/** Docker secret name carrying the secret access key. */
export const S3_SECRET_LABEL = 'swarmy.s3.secret';

// ── Pure request/response builders (unit-tested) ─────────────────────────────

/** Admin API base as seen from a host-networked container on a swarm node. */
export function garageAdminBase(): string {
  return `http://127.0.0.1:${GARAGE_ADMIN_PORT}/v1`;
}

/** In-swarm S3 endpoint attached apps receive (mirrors replicatedStore.endpointFor). */
export function garageS3Endpoint(): string {
  return `http://${STORE_SERVICE_NAME}:${GARAGE_S3_PORT}`;
}

export const STATUS_MARKER = '__SWARMY_STATUS__:';
export const BUCKET_MARKER = '__SWARMY_BUCKET__:';

/**
 * One-shot shell script for a single admin call. The token and (optional) JSON
 * body ride as container env — never argv, never disk — per the runOnce
 * one-shot-secret contract. Output = `__SWARMY_STATUS__:<code>` + response body.
 */
export function buildAdminScript(): string {
  return [
    'set -eu',
    'H="Authorization: Bearer $GARAGE_ADMIN_TOKEN"',
    'if [ -n "${GARAGE_BODY:-}" ]; then',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$GARAGE_METHOD" -H "$H" -H "Content-Type: application/json" --data-binary "$GARAGE_BODY" "$GARAGE_URL")',
    'else',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$GARAGE_METHOD" -H "$H" "$GARAGE_URL")',
    'fi',
    `echo "${STATUS_MARKER}$code"`,
    'cat /tmp/swarmy.out',
  ].join('\n');
}

/**
 * One-shot script fetching bucket info for a controller-provided id list in a
 * single container run (avoids one runOnce per bucket on every overview poll).
 */
export function buildBucketDumpScript(): string {
  return [
    'set -eu',
    'H="Authorization: Bearer $GARAGE_ADMIN_TOKEN"',
    'for id in $GARAGE_BUCKET_IDS; do',
    `  echo "${BUCKET_MARKER}$id"`,
    '  curl -sS -H "$H" "$GARAGE_BASE/bucket?id=$id" || true',
    '  echo ""',
    'done',
  ].join('\n');
}

export interface AdminResponse {
  status: number;
  body: string;
}

/** Parse `buildAdminScript` output → { status, body }. */
export function parseAdminOutput(output: string): AdminResponse {
  const idx = output.indexOf(STATUS_MARKER);
  if (idx < 0) return { status: 0, body: output.trim() };
  const rest = output.slice(idx + STATUS_MARKER.length);
  const nl = rest.indexOf('\n');
  const code = Number.parseInt((nl >= 0 ? rest.slice(0, nl) : rest).trim(), 10);
  return {
    status: Number.isNaN(code) ? 0 : code,
    body: nl >= 0 ? rest.slice(nl + 1).trim() : '',
  };
}

/** Extract bucket ids from `GET /v1/bucket?list` JSON. */
export function parseBucketIds(listJson: unknown): string[] {
  if (!Array.isArray(listJson)) return [];
  return listJson
    .map((b) => (b && typeof b === 'object' ? (b as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Split `buildBucketDumpScript` output into per-bucket JSON payloads. */
export function parseBucketDump(output: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = output.split(BUCKET_MARKER);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const id = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    if (id && body) out.set(id, body);
  }
  return out;
}

/** Garage `GetBucketInfo` — the fields we consume (defensively normalized). */
interface GarageBucketInfo {
  id?: string;
  globalAliases?: string[];
  websiteAccess?: boolean;
  objects?: number;
  bytes?: number;
  unfinishedUploads?: number;
  quotas?: { maxSize?: number | null; maxObjects?: number | null };
  keys?: Array<{
    accessKeyId?: string;
    name?: string;
    permissions?: { read?: boolean; write?: boolean; owner?: boolean };
  }>;
}

/** Normalize a Garage bucket-info payload into the view shape. */
export function normalizeBucketInfo(raw: unknown): BucketSummaryView & {
  keys: Array<{ accessKeyId: string; name: string; permissions: BucketPermissionsView }>;
} {
  const b = (raw ?? {}) as GarageBucketInfo;
  const quotas: BucketQuotaView = {
    maxSizeBytes: typeof b.quotas?.maxSize === 'number' ? b.quotas.maxSize : null,
    maxObjects: typeof b.quotas?.maxObjects === 'number' ? b.quotas.maxObjects : null,
  };
  const keys = (b.keys ?? [])
    .filter((k) => typeof k.accessKeyId === 'string')
    .map((k) => ({
      accessKeyId: k.accessKeyId as string,
      name: k.name ?? '',
      permissions: {
        read: Boolean(k.permissions?.read),
        write: Boolean(k.permissions?.write),
        owner: Boolean(k.permissions?.owner),
      },
    }));
  return {
    id: b.id ?? '',
    name: b.globalAliases?.[0] ?? b.id ?? '',
    usageBytes: typeof b.bytes === 'number' ? b.bytes : 0,
    objects: typeof b.objects === 'number' ? b.objects : 0,
    unfinishedUploads: typeof b.unfinishedUploads === 'number' ? b.unfinishedUploads : 0,
    website: Boolean(b.websiteAccess),
    quotas,
    keyCount: keys.length,
    keys,
  };
}

/** `POST /v1/bucket/allow|deny` body. */
export function buildGrantBody(
  bucketId: string,
  accessKeyId: string,
  permissions: BucketPermissionsView,
): string {
  return JSON.stringify({
    bucketId,
    accessKeyId,
    permissions: {
      read: Boolean(permissions.read),
      write: Boolean(permissions.write),
      owner: Boolean(permissions.owner),
    },
  });
}

/** `PUT /v1/bucket?id=` body setting quotas (null = unlimited). */
export function buildQuotaBody(quotas: BucketQuotaView): string {
  return JSON.stringify({
    quotas: { maxSize: quotas.maxSizeBytes, maxObjects: quotas.maxObjects },
  });
}

/** `PUT /v1/bucket?id=` body toggling website access (OFF keeps docs unset). */
export function buildWebsiteBody(input: {
  enabled: boolean;
  indexDocument?: string;
  errorDocument?: string;
}): string {
  return JSON.stringify({
    websiteAccess: input.enabled
      ? {
          enabled: true,
          indexDocument: input.indexDocument ?? 'index.html',
          ...(input.errorDocument ? { errorDocument: input.errorDocument } : {}),
        }
      : { enabled: false },
  });
}

/** Docker secret name for an attach (Docker allows [a-zA-Z0-9-_.], ≤64 chars). */
export function attachSecretName(service: string, bucket: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `swarmy-s3-${clean(service)}-${clean(bucket)}`.slice(0, 64);
}

/** Garage key name for an attach (visible in key lists — keep it descriptive). */
export function attachKeyName(service: string, bucket: string): string {
  return `swarmy-attach-${service}-${bucket}`.slice(0, 64);
}

/** The S3_* env an attached app receives (secret rides as a file, not env). */
export function buildAttachEnv(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretName: string;
}): Record<string, string> {
  return {
    S3_ENDPOINT: input.endpoint,
    S3_REGION: input.region,
    S3_BUCKET: input.bucket,
    S3_ACCESS_KEY_ID: input.accessKeyId,
    S3_SECRET_ACCESS_KEY_FILE: `/run/secrets/${input.secretName}`,
  };
}

/**
 * Next Docker-secret name for a key rotation, following the secret-family
 * versioning codec from `secretsMgr.service.ts`: the attach-time secret
 * (`swarmy-s3-<svc>-<bucket>`) becomes the family; each rotation appends
 * `__v<n>`. The family doubles as the stable mount target so the app's
 * `S3_SECRET_ACCESS_KEY_FILE` path survives every subsequent rotation.
 */
export function rotatedSecretName(current: string): { family: string; name: string } {
  const parsed = parsePhysicalSecretName(current);
  // ≤56 chars leaves room for the `__v<n>` suffix inside Docker's 64-char cap.
  const family = (parsed?.family ?? current).slice(0, 56);
  const name = physicalSecretName(family, (parsed?.version ?? 1) + 1);
  return { family, name };
}

/** Env var keys `buildAttachEnv` owns (removed again on detach). */
export const ATTACH_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY_FILE',
] as const;

// ── Store access ──────────────────────────────────────────────────────────────

interface StoreHandle {
  region: string;
  adminToken: string;
  memberNodeIds: string[];
}

/** Load the org's StorageCluster row; null when the store is off/never set up. */
async function loadStore(ctx: OrgContext): Promise<StoreHandle | null> {
  const row = await ctx.db.storageCluster.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!row || !row.enabled || row.driver === 'NONE' || !row.adminTokenRef) return null;
  return {
    region: row.region,
    adminToken: decryptSecret(row.adminTokenRef),
    memberNodeIds: Array.isArray(row.memberNodeIds) ? (row.memberNodeIds as string[]) : [],
  };
}

async function requireStore(ctx: OrgContext): Promise<StoreHandle> {
  const store = await loadStore(ctx);
  if (!store) {
    throw commandRejected(
      'object storage is disabled — enable the replicated store on the Backups page first',
    );
  }
  return store;
}

/** Prefer an online store member (the admin port is published there); fall back to a manager. */
async function storeNode(ctx: OrgContext, store: StoreHandle): Promise<{ id: string }> {
  const online = store.memberNodeIds.find((id) => ctx.hub.isOnline(id));
  if (online) return { id: online };
  return resolveManagerNode(ctx);
}

interface AdminCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under /v1, e.g. `/bucket?list`. */
  path: string;
  body?: string;
}

/** Dispatch one admin call as a runOnce curl; throws a typed error on HTTP ≥400. */
async function garageAdmin(ctx: OrgContext, store: StoreHandle, call: AdminCall): Promise<string> {
  const node = await storeNode(ctx, store);
  let res: RunOnceResult;
  try {
    res = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      {
        image: CURL_IMAGE,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [buildAdminScript()],
        env: {
          GARAGE_ADMIN_TOKEN: store.adminToken,
          GARAGE_METHOD: call.method,
          GARAGE_URL: `${garageAdminBase()}${call.path}`,
          ...(call.body ? { GARAGE_BODY: call.body } : {}),
        },
        networks: ['host'],
        pull: true,
        timeoutMs: DISPATCH_TIMEOUT_MS,
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS + 15_000 },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  const { status, body } = parseAdminOutput(res.output);
  if (res.exitCode !== 0 && status === 0) {
    throw commandRejected(`object store unreachable: ${res.output.slice(-300) || 'curl failed'}`);
  }
  if (status >= 400) {
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // non-JSON error body — keep the raw slice
    }
    throw commandRejected(`garage admin API ${status}: ${message || call.path}`);
  }
  return body;
}

function parseJson<T>(body: string, what: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw commandRejected(`unexpected ${what} response from the object store`);
  }
}

// ── Attachments (Docker-truth: swarmy.s3.* labels on app services) ────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function attachmentsFor(ctx: OrgContext, bucketName: string): BucketAttachmentView[] {
  return liveOrgServices(ctx)
    .filter((s) => s.labels[S3_BUCKET_LABEL] === bucketName)
    .map((s) => ({
      service: s.name,
      stack: s.stack,
      accessKeyId: s.labels[S3_KEY_LABEL] ?? '',
      secretName: s.labels[S3_SECRET_LABEL] ?? '',
    }));
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * The buckets surface: store state + every bucket with usage. `disabled` and
 * `unreachable` are rendered states, not errors — the UI shows an enable CTA.
 */
export async function overview(ctx: OrgContext): Promise<BucketsOverview> {
  const store = await loadStore(ctx);
  if (!store) {
    return { state: 'disabled', endpoint: null, region: 'swarmy', buckets: [] };
  }
  try {
    const listBody = await garageAdmin(ctx, store, { method: 'GET', path: '/bucket?list' });
    const ids = parseBucketIds(parseJson<unknown>(listBody, 'bucket list'));
    if (ids.length === 0) {
      return { state: 'ready', endpoint: garageS3Endpoint(), region: store.region, buckets: [] };
    }
    const node = await storeNode(ctx, store);
    const dump = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      {
        image: CURL_IMAGE,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [buildBucketDumpScript()],
        env: {
          GARAGE_ADMIN_TOKEN: store.adminToken,
          GARAGE_BASE: garageAdminBase(),
          GARAGE_BUCKET_IDS: ids.join(' '),
        },
        networks: ['host'],
        pull: true,
        timeoutMs: DISPATCH_TIMEOUT_MS,
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS + 15_000 },
    );
    const buckets: BucketSummaryView[] = [];
    const byId = parseBucketDump(dump.output);
    for (const id of ids) {
      const body = byId.get(id);
      if (!body) continue;
      try {
        const { keys: _keys, ...summary } = normalizeBucketInfo(JSON.parse(body));
        buckets.push(summary);
      } catch {
        // one malformed bucket payload must not sink the whole list
      }
    }
    buckets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { state: 'ready', endpoint: garageS3Endpoint(), region: store.region, buckets };
  } catch (e) {
    return {
      state: 'unreachable',
      endpoint: null,
      region: store.region,
      buckets: [],
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Bucket detail: usage + per-key grants (from Garage) + attachments (labels). */
export async function getBucket(ctx: OrgContext, bucketId: string): Promise<BucketDetailView> {
  const store = await requireStore(ctx);
  const body = await garageAdmin(ctx, store, {
    method: 'GET',
    path: `/bucket?id=${encodeURIComponent(bucketId)}`,
  });
  const info = normalizeBucketInfo(parseJson<unknown>(body, 'bucket info'));
  if (!info.id) throw notFound('bucket', bucketId);
  return { ...info, attachments: attachmentsFor(ctx, info.name) };
}

/** All access keys in the store (ids + names only — secrets are never listed). */
export async function listKeys(ctx: OrgContext): Promise<BucketKeysView> {
  const store = await loadStore(ctx);
  if (!store) return { state: 'disabled', keys: [] };
  try {
    const body = await garageAdmin(ctx, store, { method: 'GET', path: '/key?list' });
    const raw = parseJson<Array<{ id?: string; name?: string }>>(body, 'key list');
    const keys: StorageAccessKeyView[] = (Array.isArray(raw) ? raw : [])
      .filter((k) => typeof k.id === 'string')
      .map((k) => ({ id: k.id as string, name: k.name ?? '' }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { state: 'ready', keys };
  } catch {
    return { state: 'unreachable', keys: [] };
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createBucket(
  ctx: OrgContext,
  input: CreateBucketInput,
): Promise<BucketSummaryView> {
  const store = await requireStore(ctx);
  const body = await garageAdmin(ctx, store, {
    method: 'POST',
    path: '/bucket',
    body: JSON.stringify({ globalAlias: input.name }),
  });
  const { keys: _keys, ...summary } = normalizeBucketInfo(parseJson<unknown>(body, 'bucket'));
  await writeAudit(ctx, {
    action: 'buckets.create',
    targetType: 'bucket',
    targetId: summary.id,
    metadata: { name: input.name },
  });
  return summary;
}

/** Delete a bucket — refused while it still holds objects (clear guard first). */
export async function deleteBucket(
  ctx: OrgContext,
  bucketId: string,
): Promise<{ id: string; removed: true }> {
  const store = await requireStore(ctx);
  const info = await getBucket(ctx, bucketId);
  if (info.objects > 0) {
    throw commandRejected(
      `bucket "${info.name}" still holds ${info.objects} object(s) — empty it before deleting`,
    );
  }
  if (info.attachments.length > 0) {
    throw commandRejected(
      `bucket "${info.name}" is attached to ${info.attachments
        .map((a) => a.service)
        .join(', ')} — detach first`,
    );
  }
  await garageAdmin(ctx, store, {
    method: 'DELETE',
    path: `/bucket?id=${encodeURIComponent(bucketId)}`,
  });
  await writeAudit(ctx, {
    action: 'buckets.delete',
    targetType: 'bucket',
    targetId: bucketId,
    metadata: { name: info.name },
  });
  return { id: bucketId, removed: true };
}

/** Mint a key in Garage (no audit — the callers record their own action). */
async function mintKey(
  ctx: OrgContext,
  store: StoreHandle,
  name: string,
): Promise<BucketKeyCreatedView> {
  const body = await garageAdmin(ctx, store, {
    method: 'POST',
    path: '/key',
    body: JSON.stringify({ name }),
  });
  const raw = parseJson<{ accessKeyId?: string; secretAccessKey?: string; name?: string }>(
    body,
    'key',
  );
  if (!raw.accessKeyId || !raw.secretAccessKey) {
    throw commandRejected('object store did not return a key');
  }
  return {
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    name: raw.name ?? name,
  };
}

/**
 * Mint an access key. The secret is returned ONCE here and never persisted
 * controller-side — Garage will not reveal it again.
 */
export async function createKey(ctx: OrgContext, name: string): Promise<BucketKeyCreatedView> {
  const store = await requireStore(ctx);
  const key = await mintKey(ctx, store, name);
  await writeAudit(ctx, {
    action: 'buckets.createKey',
    targetType: 'bucketKey',
    targetId: key.accessKeyId,
    metadata: { name },
  });
  return key;
}

export async function deleteKey(
  ctx: OrgContext,
  accessKeyId: string,
): Promise<{ accessKeyId: string; removed: true }> {
  const store = await requireStore(ctx);
  const inUse = liveOrgServices(ctx).filter((s) => s.labels[S3_KEY_LABEL] === accessKeyId);
  if (inUse.length > 0) {
    throw commandRejected(
      `key ${accessKeyId} is used by ${inUse.map((s) => s.name).join(', ')} — detach first`,
    );
  }
  await garageAdmin(ctx, store, {
    method: 'DELETE',
    path: `/key?id=${encodeURIComponent(accessKeyId)}`,
  });
  await writeAudit(ctx, {
    action: 'buckets.deleteKey',
    targetType: 'bucketKey',
    targetId: accessKeyId,
  });
  return { accessKeyId, removed: true };
}

/** Garage `GetKeyInfo` — the fields rotation consumes. */
interface GarageKeyInfo {
  name?: string;
  accessKeyId?: string;
  buckets?: Array<{
    id?: string;
    globalAliases?: string[];
    permissions?: { read?: boolean; write?: boolean; owner?: boolean };
  }>;
}

export interface RotateKeyResult {
  oldAccessKeyId: string;
  /** The replacement key id (grants identical to the old key's). */
  accessKeyId: string;
  name: string;
  /** App services re-deployed onto the new key + rotated Docker secret. */
  redeployed: string[];
  /**
   * The new secret — returned ONCE, and only when no attachment consumed it
   * (attached rotations land the secret straight in the Docker secret).
   */
  secretAccessKey: string | null;
}

/**
 * Rotate an access key: mint a replacement with identical bucket grants, swap
 * every attached app onto it (new versioned Docker secret + redeploy, the
 * secret-family pattern from `secretsMgr.service.ts`), then retire the old
 * Garage key. The old credential is dead when this returns.
 */
export async function rotateAccessKey(
  ctx: OrgContext,
  accessKeyId: string,
): Promise<RotateKeyResult> {
  const store = await requireStore(ctx);
  const infoBody = await garageAdmin(ctx, store, {
    method: 'GET',
    path: `/key?id=${encodeURIComponent(accessKeyId)}`,
  });
  const info = parseJson<GarageKeyInfo>(infoBody, 'key info');
  const name = info.name ?? '';

  // 1. Replacement key, same display name, identical grants.
  const next = await mintKey(ctx, store, name || `rotated-${accessKeyId}`);
  for (const b of info.buckets ?? []) {
    if (typeof b.id !== 'string' || !b.id) continue;
    await garageAdmin(ctx, store, {
      method: 'POST',
      path: '/bucket/allow',
      body: buildGrantBody(b.id, next.accessKeyId, {
        read: Boolean(b.permissions?.read),
        write: Boolean(b.permissions?.write),
        owner: Boolean(b.permissions?.owner),
      }),
    });
  }

  // 2. Re-wire attached apps: versioned Docker secret + redeploy (env + labels).
  const attached = liveOrgServices(ctx).filter((s) => s.labels[S3_KEY_LABEL] === accessKeyId);
  const redeployed: string[] = [];
  if (attached.length > 0) {
    const node = await resolveManagerNode(ctx);
    for (const app of attached) {
      const bucketName = app.labels[S3_BUCKET_LABEL] ?? '';
      const oldSecretName = app.labels[S3_SECRET_LABEL] ?? attachSecretName(app.name, bucketName);
      const { family, name: newSecretName } = rotatedSecretName(oldSecretName);
      const dataB64 = Buffer.from(next.secretAccessKey, 'utf8').toString('base64');
      try {
        try {
          await ctx.hub.dispatch(node.id, 'secret.create', {
            name: newSecretName,
            dataB64,
            labels: { 'swarmy.managed': 'true', [S3_BUCKET_LABEL]: bucketName },
          });
        } catch (e) {
          if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
          await ctx.hub.dispatch(node.id, 'secret.remove', { name: newSecretName });
          await ctx.hub.dispatch(node.id, 'secret.create', {
            name: newSecretName,
            dataB64,
            labels: { 'swarmy.managed': 'true', [S3_BUCKET_LABEL]: bucketName },
          });
        }

        const env: Record<string, string> = {};
        for (const kv of app.env) {
          const i = kv.indexOf('=');
          env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
        }
        env.S3_ACCESS_KEY_ID = next.accessKeyId;
        // target = family keeps this path stable across every later rotation.
        env.S3_SECRET_ACCESS_KEY_FILE = `/run/secrets/${family}`;

        const otherSecrets = (app.secrets ?? []).filter(
          (n) =>
            n !== newSecretName &&
            n !== oldSecretName &&
            parsePhysicalSecretName(n)?.family !== family,
        );
        const spec: ServiceSpec = {
          name: app.name,
          image: app.image,
          mode: { replicated: { replicas: app.replicas.desired } },
          labels: {
            ...app.labels,
            ...(app.stack !== 'UNGROUPED' ? { [STACK_LABEL]: app.stack } : {}),
            [S3_KEY_LABEL]: next.accessKeyId,
            [S3_SECRET_LABEL]: newSecretName,
          },
          env,
          ports: app.ports.map((p) => ({
            target: p.target,
            published: p.published,
            protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
            mode: 'ingress' as const,
          })),
          networks: app.networks.map((n) => n.name),
          secrets: [...secretRefsFor(otherSecrets), { source: newSecretName, target: family }],
          ...(app.configs && app.configs.length > 0
            ? { configs: app.configs.map((n) => ({ source: n })) }
            : {}),
        };
        await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
      } catch (e) {
        throw mapDispatchError(e);
      }
      redeployed.push(app.name);
      // Best-effort: the redeploy already moved the app off the old secret.
      await ctx.hub
        .dispatch(node.id, 'secret.remove', { name: oldSecretName })
        .catch(() => undefined);
    }
  }

  // 3. Retire the old key — apps are already off it.
  await garageAdmin(ctx, store, {
    method: 'DELETE',
    path: `/key?id=${encodeURIComponent(accessKeyId)}`,
  });

  await writeAudit(ctx, {
    action: 'buckets.rotateKey',
    targetType: 'bucketKey',
    targetId: next.accessKeyId,
    metadata: { oldAccessKeyId: accessKeyId, name, redeployed },
  });
  return {
    oldAccessKeyId: accessKeyId,
    accessKeyId: next.accessKeyId,
    name: next.name,
    redeployed: redeployed.sort(),
    secretAccessKey: attached.length === 0 ? next.secretAccessKey : null,
  };
}

// ── Presigned URLs ────────────────────────────────────────────────────────────

/** Display name of the controller-held key that signs presigned URLs. */
export const PRESIGN_KEY_NAME = 'swarmy-presign';

/**
 * The controller-held signing key (the ONE credential the DB may hold, as
 * encrypted `*Ref` columns on the StorageCluster row — same pattern as the
 * admin token). Minted lazily on first presign.
 */
async function ensurePresignKey(
  ctx: OrgContext,
  store: StoreHandle,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const row = await ctx.db.storageCluster.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!row) throw notFound('storage cluster', ctx.activeOrgId);
  if (row.accessKeyRef && row.secretKeyRef) {
    return {
      accessKeyId: decryptSecret(row.accessKeyRef),
      secretAccessKey: decryptSecret(row.secretKeyRef),
    };
  }
  const key = await mintKey(ctx, store, PRESIGN_KEY_NAME);
  await ctx.db.storageCluster.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      accessKeyRef: encryptSecret(key.accessKeyId),
      secretKeyRef: encryptSecret(key.secretAccessKey),
    },
  });
  return { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
}

export interface PresignUrlInput {
  bucketId: string;
  key: string;
  method: 'GET' | 'PUT';
  expiresSeconds: number;
}

export interface PresignedUrlView {
  url: string;
  bucket: string;
  key: string;
  method: 'GET' | 'PUT';
  expiresAt: string;
}

/**
 * Mint a time-limited presigned GET/PUT URL for one object. Signing is the
 * pure SigV4 presigner (`s3-presign.ts`); the signing key is the cluster's
 * controller-held presign key, granted read+write on the bucket on demand.
 */
export async function presignObjectUrl(
  ctx: OrgContext,
  input: PresignUrlInput,
): Promise<PresignedUrlView> {
  if (input.expiresSeconds < 1 || input.expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS) {
    throw commandRejected(`expiry must be between 1s and ${MAX_PRESIGN_EXPIRES_SECONDS}s (7 days)`);
  }
  const store = await requireStore(ctx);
  // Also proves the bucket belongs to THIS org's store (404 otherwise).
  const bucket = await getBucket(ctx, input.bucketId);
  const creds = await ensurePresignKey(ctx, store);

  const grant = bucket.keys.find((k) => k.accessKeyId === creds.accessKeyId);
  if (!grant?.permissions.read || !grant.permissions.write) {
    await garageAdmin(ctx, store, {
      method: 'POST',
      path: '/bucket/allow',
      body: buildGrantBody(bucket.id, creds.accessKeyId, {
        read: true,
        write: true,
        owner: false,
      }),
    });
  }

  const now = new Date();
  const url = presignS3Url({
    endpoint: garageS3Endpoint(),
    region: store.region,
    bucket: bucket.name,
    key: input.key,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    method: input.method,
    expiresSeconds: input.expiresSeconds,
    now,
  });
  await writeAudit(ctx, {
    action: 'buckets.presign',
    targetType: 'bucket',
    targetId: bucket.id,
    metadata: { key: input.key, method: input.method, expiresSeconds: input.expiresSeconds },
  });
  return {
    url,
    bucket: bucket.name,
    key: input.key,
    method: input.method,
    expiresAt: new Date(now.getTime() + input.expiresSeconds * 1000).toISOString(),
  };
}

export async function grantKeyOnBucket(
  ctx: OrgContext,
  input: GrantKeyOnBucketInput,
): Promise<{ bucketId: string; accessKeyId: string; mode: 'allow' | 'deny' }> {
  const store = await requireStore(ctx);
  await garageAdmin(ctx, store, {
    method: 'POST',
    path: `/bucket/${input.mode}`,
    body: buildGrantBody(input.bucketId, input.accessKeyId, input.permissions),
  });
  await writeAudit(ctx, {
    action: 'buckets.grantKey',
    targetType: 'bucket',
    targetId: input.bucketId,
    metadata: { accessKeyId: input.accessKeyId, mode: input.mode, permissions: input.permissions },
  });
  return { bucketId: input.bucketId, accessKeyId: input.accessKeyId, mode: input.mode };
}

export async function setQuota(
  ctx: OrgContext,
  input: SetBucketQuotaInput,
): Promise<BucketSummaryView> {
  const store = await requireStore(ctx);
  const body = await garageAdmin(ctx, store, {
    method: 'PUT',
    path: `/bucket?id=${encodeURIComponent(input.bucketId)}`,
    body: buildQuotaBody({ maxSizeBytes: input.maxSizeBytes, maxObjects: input.maxObjects }),
  });
  const { keys: _keys, ...summary } = normalizeBucketInfo(parseJson<unknown>(body, 'bucket'));
  await writeAudit(ctx, {
    action: 'buckets.setQuota',
    targetType: 'bucket',
    targetId: input.bucketId,
    metadata: { maxSizeBytes: input.maxSizeBytes, maxObjects: input.maxObjects },
  });
  return summary;
}

/** Toggle static-website serving (OFF by default; ON makes objects public). */
export async function setWebsite(
  ctx: OrgContext,
  input: SetBucketWebsiteInput,
): Promise<BucketSummaryView> {
  const store = await requireStore(ctx);
  const body = await garageAdmin(ctx, store, {
    method: 'PUT',
    path: `/bucket?id=${encodeURIComponent(input.bucketId)}`,
    body: buildWebsiteBody(input),
  });
  const { keys: _keys, ...summary } = normalizeBucketInfo(parseJson<unknown>(body, 'bucket'));
  await writeAudit(ctx, {
    action: 'buckets.setWebsite',
    targetType: 'bucket',
    targetId: input.bucketId,
    metadata: { enabled: input.enabled },
  });
  return summary;
}

/**
 * Wire an app service to a bucket: mint a bucket-scoped key (read+write, not
 * owner), store its secret as a Docker secret, and redeploy the app with the
 * `S3_*` env + secret ref + `swarmy.s3.*` labels. Mirrors manageddb
 * injectConnection (same lossy-merge caveat: mounts/constraints are not exposed
 * by the live inventory and are not re-applied here).
 */
export async function attachToService(
  ctx: OrgContext,
  input: AttachBucketInput,
): Promise<BucketAttachResult> {
  const store = await requireStore(ctx);
  const bucket = await getBucket(ctx, input.bucketId);

  const app = liveOrgServices(ctx).find(
    (s) => s.id === input.appService || s.name === input.appService,
  );
  if (!app) throw notFound('service', input.appService);
  if (app.labels[S3_BUCKET_LABEL]) {
    throw commandRejected(
      `service "${app.name}" is already attached to bucket "${app.labels[S3_BUCKET_LABEL]}" — detach first`,
    );
  }

  // 1. Bucket-scoped key. The secret exists in memory only until it becomes a Docker secret.
  const key = await createKey(ctx, attachKeyName(app.name, bucket.name));
  await grantKeyOnBucket(ctx, {
    bucketId: bucket.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: false },
    mode: 'allow',
  });

  // 2. Docker secret (replace a stale one from a previous attach if present).
  const secretName = attachSecretName(app.name, bucket.name);
  const dataB64 = Buffer.from(key.secretAccessKey, 'utf8').toString('base64');
  const secretLabels = { 'swarmy.managed': 'true', [S3_BUCKET_LABEL]: bucket.name };
  const node = await resolveManagerNode(ctx);
  try {
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: secretName,
        dataB64,
        labels: secretLabels,
      });
    } catch (e) {
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: secretName });
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: secretName,
        dataB64,
        labels: secretLabels,
      });
    }

    // 3. Redeploy the app with merged env + secret ref + wiring labels.
    const env: Record<string, string> = {};
    for (const kv of app.env) {
      const i = kv.indexOf('=');
      env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
    }
    Object.assign(
      env,
      buildAttachEnv({
        endpoint: garageS3Endpoint(),
        region: store.region,
        bucket: bucket.name,
        accessKeyId: key.accessKeyId,
        secretName,
      }),
    );
    const secrets = [
      ...(app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
      { source: secretName },
    ];
    const spec: ServiceSpec = {
      name: app.name,
      image: app.image,
      mode: { replicated: { replicas: app.replicas.desired } },
      labels: {
        ...app.labels,
        ...(app.stack !== 'UNGROUPED' ? { [STACK_LABEL]: app.stack } : {}),
        [S3_BUCKET_LABEL]: bucket.name,
        [S3_KEY_LABEL]: key.accessKeyId,
        [S3_SECRET_LABEL]: secretName,
      },
      env,
      ports: app.ports.map((p) => ({
        target: p.target,
        published: p.published,
        protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
        mode: 'ingress' as const,
      })),
      networks: app.networks.map((n) => n.name),
      secrets,
      ...(app.configs && app.configs.length > 0
        ? { configs: app.configs.map((n) => ({ source: n })) }
        : {}),
    };
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'buckets.attach',
    targetType: 'bucket',
    targetId: bucket.id,
    metadata: { appService: app.name, bucket: bucket.name, accessKeyId: key.accessKeyId },
  });
  return {
    appService: app.name,
    bucket: bucket.name,
    accessKeyId: key.accessKeyId,
    secretName,
    endpoint: garageS3Endpoint(),
    region: store.region,
  };
}

/** Unwire an app: drop the S3 env + secret ref + labels, then retire the key. */
export async function detach(
  ctx: OrgContext,
  appService: string,
): Promise<{ appService: string; bucket: string; detached: true }> {
  const store = await requireStore(ctx);
  const app = liveOrgServices(ctx).find((s) => s.id === appService || s.name === appService);
  if (!app) throw notFound('service', appService);
  const bucketName = app.labels[S3_BUCKET_LABEL];
  if (!bucketName) throw commandRejected(`service "${app.name}" has no bucket attached`);
  const accessKeyId = app.labels[S3_KEY_LABEL] ?? '';
  const secretName = app.labels[S3_SECRET_LABEL] ?? attachSecretName(app.name, bucketName);

  const env: Record<string, string> = {};
  const owned = new Set<string>(ATTACH_ENV_KEYS);
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    const k = i >= 0 ? kv.slice(0, i) : kv;
    if (owned.has(k)) continue;
    env[k] = i >= 0 ? kv.slice(i + 1) : '';
  }
  const labels = { ...app.labels };
  delete labels[S3_BUCKET_LABEL];
  delete labels[S3_KEY_LABEL];
  delete labels[S3_SECRET_LABEL];

  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels,
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: app.networks.map((n) => n.name),
    secrets: (app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  // Best-effort cleanup: the redeploy already cut access; failures must not block.
  await ctx.hub.dispatch(node.id, 'secret.remove', { name: secretName }).catch(() => undefined);
  if (accessKeyId) {
    await garageAdmin(ctx, store, {
      method: 'DELETE',
      path: `/key?id=${encodeURIComponent(accessKeyId)}`,
    }).catch(() => undefined);
  }

  await writeAudit(ctx, {
    action: 'buckets.detach',
    targetType: 'bucket',
    targetId: bucketName,
    metadata: { appService: app.name, accessKeyId },
  });
  return { appService: app.name, bucket: bucketName, detached: true };
}
