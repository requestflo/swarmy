/**
 * Shared certificate storage for the edge-per-node topology (geo-edge).
 *
 * Why: with one Caddy per ingress node and geo-DNS in front, Let's Encrypt's
 * multi-vantage validation lands on whichever edge each vantage point is
 * steered to — and only the edge that placed the order holds the HTTP-01 /
 * TLS-ALPN-01 token when every edge keeps its own local storage. One shared
 * CertMagic store fixes that: any edge can answer any challenge, there is one
 * ACME account, and a cert is issued once for the whole fleet.
 *
 * Where: swarmy's OWN replicated object store (Garage) — no new data service,
 * certificates replicate across nodes/regions with the store. Caddy speaks to it through `storage s3`
 * (techknowlogick/certmagic-s3, compiled into docker/caddy-swarmy).
 *
 * Credentials never touch the Caddyfile: a bucket-scoped Garage key is minted,
 * written as an AWS shared-credentials INI into a Docker secret, and mounted on
 * the edge service with `AWS_SHARED_CREDENTIALS_FILE` pointing at it — the
 * module resolves credentials through the AWS SDK default chain. So neither the
 * rendered Caddyfile, the admin-API JSON nor Caddy's autosave ever holds them.
 *
 * Persisted state is non-secret coordinates only (`IngressSettings.certStorage`:
 * bucket, key id, secret NAME) — the secret access key exists solely inside the
 * Docker secret.
 *
 * Encrypted at rest: certificates and the ACME account key are sealed
 * client-side (the module's NaCl secretbox `encryption_key`) before they reach
 * Garage, so the store never holds a usable
 * private key. The key is its own Docker secret, pulled into the `storage s3`
 * block with a Caddyfile `import` — never in the DB, an env var or the rendered
 * Caddyfile. (Each edge's own Caddy autosave, on that node's config volume,
 * does carry the adapted config including the key: the same trust boundary as
 * the edge process, which holds the decrypted certificates anyway.) It lives
 * only in the swarm; lose it and the edges simply issue fresh certificates
 * (they are reproducible), so no copy is kept elsewhere.
 */
import { randomBytes } from 'node:crypto';
import type { CertStorage } from '@swarmy/ingress';
import { SWARMY_OVERLAY_NETWORK } from '@swarmy/core';
import type { RunOnceResult, SecretListResult } from '@swarmy/core/protocol';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { objectStoreState, provisionSystemBucketKey, revokeSystemKey } from './buckets.service';
import { RCLONE_IMAGE, rcloneRemoteEnv } from './rclone';

/** The one bucket every org edge shares (per-org key prefix inside it). */
export const EDGE_CERTS_BUCKET = 'swarmy-edge-certs';
/** Garage key name (shows in the Buckets → Keys list as platform plumbing). */
export const EDGE_CERTS_KEY_NAME = 'swarmy-edge-certs';
/** File name under /run/secrets/ inside every edge task. */
export const EDGE_CERTS_SECRET_TARGET = 'swarmy-edge-certs-s3';
/** What `AWS_SHARED_CREDENTIALS_FILE` points at on the edge service. */
export const EDGE_CERTS_CREDENTIALS_FILE = `/run/secrets/${EDGE_CERTS_SECRET_TARGET}`;
/** The encryption-key snippet's file name under /run/secrets/ in every edge task. */
export const EDGE_CERTS_ENC_TARGET = 'swarmy-edge-certs-enc';
/** What the rendered `storage s3` block imports. */
export const EDGE_CERTS_ENC_FILE = `/run/secrets/${EDGE_CERTS_ENC_TARGET}`;

export const OBJECT_STORAGE_REQUIRED_MESSAGE =
  'Turn on swarmy object storage first — the edges share certificates through it. ' +
  'Without one shared certificate store, each edge would issue its own certificates and, ' +
  "with geo-DNS in front, Let's Encrypt can check a different edge than the one that asked.";

/** Non-secret coordinates persisted on the org's ingress settings. */
export interface EdgeCertStorageSettings {
  kind: 's3';
  endpoint: string;
  bucket: string;
  bucketId: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  /** Docker secret NAME carrying the credentials INI (never its content). */
  secretName: string;
  /**
   * Docker secret NAME carrying the `encryption_key` snippet. Absent on stores
   * provisioned before encryption at rest (plaintext, legacy prefix) — the
   * reconcile upgrades those.
   */
  encSecretName?: string;
  /**
   * Set when a legacy plaintext store was upgraded: the edges still hold the
   * old certificates in memory and certmagic never copies a cached cert into a
   * new store, so one edge restart (after the sealed config is applied) makes
   * them re-obtain INTO the encrypted prefix now, not at some later reboot.
   */
  reissuePending?: boolean;
  /**
   * The plaintext prefix a legacy store used, until it is purged from Garage
   * (after the edges run on the sealed store).
   */
  legacyPrefix?: string;
}

/**
 * Docker secret name for one minted key. Secrets are immutable and cannot be
 * removed while a service references them, so each key gets its own name —
 * a re-mint never collides with a secret an edge still mounts.
 * Docker allows [a-zA-Z0-9-_.], ≤64 chars. Pure.
 */
export function edgeCertsSecretName(accessKeyId: string): string {
  const suffix = accessKeyId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40).toLowerCase();
  return `swarmy-edge-certs-s3-${suffix}`;
}

/**
 * Per-org object prefix inside the shared bucket. Pure. Encrypted stores use
 * their own prefix: the module has no plaintext fallback, so sealed and legacy
 * objects must never share keys (legacy certs are simply re-issued once).
 */
export function edgeCertsPrefix(orgId: string, encrypted = true): string {
  return `${encrypted ? 'caddy-enc' : 'caddy'}/${orgId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** A fresh secretbox key: exactly 32 bytes as text (the module copies the raw string). */
export function generateEdgeCertsKey(): string {
  return randomBytes(24).toString('base64url'); // 24 bytes → 32 chars [A-Za-z0-9_-]
}

/** The encryption-key secret's content — one Caddyfile line for `import`. Pure. */
export function encryptionKeySnippet(key: string): string {
  if (key.length !== 32 || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('edge cert key must be 32 url-safe chars');
  return `encryption_key ${key}\n`;
}

/** Docker secret name for a fresh encryption key (immutable → unique per key). */
export function edgeCertsEncSecretName(): string {
  return `swarmy-edge-certs-enc-${randomBytes(6).toString('hex')}`;
}

/** AWS shared-credentials INI (the Docker secret's content). Pure. */
export function awsCredentialsIni(accessKeyId: string, secretAccessKey: string): string {
  return `[default]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`;
}

/** Render-time {@link CertStorage} from the persisted coordinates. Pure. */
export function certStorageFor(s: EdgeCertStorageSettings): CertStorage {
  return {
    kind: 's3',
    endpoint: s.endpoint,
    bucket: s.bucket,
    region: s.region,
    prefix: s.prefix,
    ...(s.encSecretName ? { encryptionKeyFile: EDGE_CERTS_ENC_FILE } : {}),
  };
}

/**
 * Edge service env + secret mount that deliver the credentials. Pure — the
 * edge spec builder merges it. `AWS_EC2_METADATA_DISABLED` stops the SDK's
 * default chain from probing an instance-metadata endpoint on cloud hosts.
 */
export function edgeCertsServiceWiring(
  secretName: string,
  encSecretName?: string,
): {
  env: Record<string, string>;
  secrets: Array<{ source: string; target: string; mode: number }>;
} {
  return {
    env: {
      AWS_SHARED_CREDENTIALS_FILE: EDGE_CERTS_CREDENTIALS_FILE,
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    secrets: [
      { source: secretName, target: EDGE_CERTS_SECRET_TARGET, mode: 0o400 },
      ...(encSecretName ? [{ source: encSecretName, target: EDGE_CERTS_ENC_TARGET, mode: 0o400 }] : []),
    ],
  };
}

/** Names of the swarm's secrets, or null when it can't tell (assume present). */
async function secretNames(ctx: OrgContext, managerNodeId: string): Promise<Set<string> | null> {
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(managerNodeId, 'secret.list', {});
    return new Set((res?.secrets ?? []).map((s) => s.name));
  } catch {
    // Can't tell — assume present rather than mint a duplicate key every tick.
    return null;
  }
}

export interface EnsureEdgeCertStorageResult {
  settings: EdgeCertStorageSettings;
  /** True when a key + secret were minted by this call. */
  created: boolean;
}

/**
 * Ensure the edge cert store: object storage on, bucket `swarmy-edge-certs`,
 * a bucket-scoped key, and its credentials in a Docker secret. Idempotent —
 * existing coordinates whose secret is still in the swarm are returned as-is
 * (zero Garage calls). Throws PRECONDITION_FAILED when object storage is off.
 */
export async function ensureEdgeCertStorage(
  ctx: OrgContext,
  current?: EdgeCertStorageSettings,
): Promise<EnsureEdgeCertStorageResult> {
  const store = await objectStoreState(ctx);
  if (!store.enabled) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: OBJECT_STORAGE_REQUIRED_MESSAGE });
  }
  const node = await resolveManagerNode(ctx);
  const names = await secretNames(ctx, node.id);
  const has = (name?: string) => Boolean(name) && (names === null || names.has(name!));
  const credsOk = Boolean(current) && has(current?.secretName);
  const encOk = credsOk && has(current?.encSecretName);
  if (current && credsOk && encOk) return { settings: current, created: false };

  let creds: Omit<EdgeCertStorageSettings, 'prefix' | 'encSecretName'>;
  if (current && credsOk) {
    const { prefix: _p, encSecretName: _e, ...keep } = current;
    creds = keep;
  } else {
    const cred = await provisionSystemBucketKey(ctx, {
      bucket: EDGE_CERTS_BUCKET,
      keyName: EDGE_CERTS_KEY_NAME,
    });
    const secretName = edgeCertsSecretName(cred.accessKeyId);
    const dataB64 = Buffer.from(awsCredentialsIni(cred.accessKeyId, cred.secretAccessKey), 'utf8').toString(
      'base64',
    );
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: secretName,
        dataB64,
        labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress-certs' },
      });
    } catch (e) {
      // Don't leave an orphaned key behind a secret that never landed.
      await revokeSystemKey(ctx, cred.accessKeyId);
      throw mapDispatchError(e);
    }
    // The previous key lost its secret (removed out-of-band) — revoke it.
    if (current && current.accessKeyId !== cred.accessKeyId) {
      await revokeSystemKey(ctx, current.accessKeyId);
    }
    creds = {
      kind: 's3',
      endpoint: cred.endpoint,
      bucket: cred.bucket,
      bucketId: cred.bucketId,
      region: cred.region,
      accessKeyId: cred.accessKeyId,
      secretName,
    };
  }

  // A new encryption key means a new (empty) sealed prefix: the edges issue
  // fresh certificates into it once. Only happens on first provision, on the
  // upgrade of a legacy plaintext store, or if the key's secret was removed.
  let encSecretName = current?.encSecretName;
  if (!encOk || !encSecretName) {
    encSecretName = edgeCertsEncSecretName();
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: encSecretName,
        dataB64: Buffer.from(encryptionKeySnippet(generateEdgeCertsKey()), 'utf8').toString('base64'),
        labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress-certs-key' },
      });
    } catch (e) {
      throw mapDispatchError(e);
    }
  }
  return {
    settings: { ...creds, prefix: edgeCertsPrefix(ctx.activeOrgId), encSecretName },
    created: true,
  };
}

/** Purge key name (a short-lived, bucket-scoped Garage key, revoked after). */
const EDGE_CERTS_PURGE_KEY_NAME = 'swarmy-edge-certs-purge';

/** The one-shot that deletes a legacy plaintext prefix. Secrets only in env. Pure. */
export function buildLegacyPurgeRunOnce(input: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}) {
  // Only ever the unsealed per-org prefix — never the sealed one or the bucket root.
  if (!/^caddy\/[A-Za-z0-9_-]+$/.test(input.prefix)) throw new Error(`refusing to purge "${input.prefix}"`);
  return {
    image: RCLONE_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    cmd: ['rclone purge "garage:$PURGE_BUCKET/$PURGE_PREFIX" || [ -z "$(rclone lsf "garage:$PURGE_BUCKET/$PURGE_PREFIX" 2>/dev/null)" ]'],
    env: {
      ...rcloneRemoteEnv('garage', {
        endpoint: input.endpoint,
        region: input.region,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        provider: 'Other',
      }),
      PURGE_BUCKET: input.bucket,
      PURGE_PREFIX: input.prefix,
    },
    networks: [SWARMY_OVERLAY_NETWORK],
    pull: true,
    timeoutMs: 5 * 60_000,
  };
}

/**
 * Delete a legacy store's plaintext objects from Garage once nothing reads
 * them. Throws on failure (the caller retries on a later tick).
 */
export async function purgeLegacyEdgeCerts(ctx: OrgContext, s: EdgeCertStorageSettings): Promise<void> {
  if (!s.legacyPrefix) return;
  const node = await resolveManagerNode(ctx);
  const cred = await provisionSystemBucketKey(ctx, { bucket: s.bucket, keyName: EDGE_CERTS_PURGE_KEY_NAME });
  try {
    const res = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      buildLegacyPurgeRunOnce({ ...cred, bucket: s.bucket, prefix: s.legacyPrefix }),
      { timeoutMs: 6 * 60_000 },
    );
    if (res.exitCode !== 0) throw new Error(`purge exited ${res.exitCode}: ${(res.output ?? '').slice(-300)}`);
  } finally {
    await revokeSystemKey(ctx, cred.accessKeyId);
  }
}
