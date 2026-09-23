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
 * certificates replicate across nodes/regions with the store, and the offsite
 * S3 mirror covers them. Caddy speaks to it through `storage s3`
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
 */
import type { CertStorage } from '@swarmy/ingress';
import type { SecretListResult } from '@swarmy/core/protocol';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { objectStoreState, provisionSystemBucketKey, revokeSystemKey } from './buckets.service';

/** The one bucket every org edge shares (per-org key prefix inside it). */
export const EDGE_CERTS_BUCKET = 'swarmy-edge-certs';
/** Garage key name (shows in the Buckets → Keys list as platform plumbing). */
export const EDGE_CERTS_KEY_NAME = 'swarmy-edge-certs';
/** File name under /run/secrets/ inside every edge task. */
export const EDGE_CERTS_SECRET_TARGET = 'swarmy-edge-certs-s3';
/** What `AWS_SHARED_CREDENTIALS_FILE` points at on the edge service. */
export const EDGE_CERTS_CREDENTIALS_FILE = `/run/secrets/${EDGE_CERTS_SECRET_TARGET}`;

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

/** Per-org object prefix inside the shared bucket. Pure. */
export function edgeCertsPrefix(orgId: string): string {
  return `caddy/${orgId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** AWS shared-credentials INI (the Docker secret's content). Pure. */
export function awsCredentialsIni(accessKeyId: string, secretAccessKey: string): string {
  return `[default]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`;
}

/** Render-time {@link CertStorage} from the persisted coordinates. Pure. */
export function certStorageFor(s: EdgeCertStorageSettings): CertStorage {
  return { kind: 's3', endpoint: s.endpoint, bucket: s.bucket, region: s.region, prefix: s.prefix };
}

/**
 * Edge service env + secret mount that deliver the credentials. Pure — the
 * edge spec builder merges it. `AWS_EC2_METADATA_DISABLED` stops the SDK's
 * default chain from probing an instance-metadata endpoint on cloud hosts.
 */
export function edgeCertsServiceWiring(secretName: string): {
  env: Record<string, string>;
  secrets: Array<{ source: string; target: string; mode: number }>;
} {
  return {
    env: {
      AWS_SHARED_CREDENTIALS_FILE: EDGE_CERTS_CREDENTIALS_FILE,
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    secrets: [{ source: secretName, target: EDGE_CERTS_SECRET_TARGET, mode: 0o400 }],
  };
}

async function secretExists(ctx: OrgContext, managerNodeId: string, name: string): Promise<boolean> {
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(managerNodeId, 'secret.list', {});
    return (res?.secrets ?? []).some((s) => s.name === name);
  } catch {
    // Can't tell — assume present rather than mint a duplicate key every tick.
    return true;
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
  if (current && (await secretExists(ctx, node.id, current.secretName))) {
    return { settings: current, created: false };
  }

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
  return {
    settings: {
      kind: 's3',
      endpoint: cred.endpoint,
      bucket: cred.bucket,
      bucketId: cred.bucketId,
      region: cred.region,
      prefix: edgeCertsPrefix(ctx.activeOrgId),
      accessKeyId: cred.accessKeyId,
      secretName,
    },
    created: true,
  };
}
