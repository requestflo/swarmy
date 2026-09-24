/**
 * rclone helpers for the one-shot containers that move objects between S3
 * stores (edge certificate sync between the Garage store and the edges). All
 * credentials travel as `RCLONE_CONFIG_*` env — never argv, never a file.
 */

export const RCLONE_IMAGE = 'rclone/rclone:1.68.2';

export interface S3RemoteConfig {
  endpoint?: string | null;
  region?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  /** rclone s3 provider; derived from the endpoint when omitted. */
  provider?: string;
}

/**
 * rclone `provider` for an S3 endpoint. Named providers get rclone's quirks
 * handled (R2's no-ACL, Wasabi's endpoint); everything else S3-compatible —
 * Backblaze B2's S3 API, MinIO, Garage — is `Other` with path-style addressing.
 */
export function s3ProviderFor(endpoint: string | null | undefined): string {
  if (!endpoint) return 'AWS';
  let host = endpoint;
  try {
    host = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname;
  } catch {
    // keep raw
  }
  if (host.endsWith('amazonaws.com')) return 'AWS';
  if (host.endsWith('r2.cloudflarestorage.com')) return 'Cloudflare';
  if (host.endsWith('wasabisys.com')) return 'Wasabi';
  return 'Other';
}

/** The `RCLONE_CONFIG_<REMOTE>_*` env that defines one s3 remote. */
export function rcloneRemoteEnv(remote: string, cfg: S3RemoteConfig): Record<string, string> {
  const R = `RCLONE_CONFIG_${remote.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const provider = cfg.provider ?? s3ProviderFor(cfg.endpoint);
  const env: Record<string, string> = {
    [`${R}_TYPE`]: 's3',
    [`${R}_PROVIDER`]: provider,
    [`${R}_ENV_AUTH`]: 'false',
    [`${R}_ACCESS_KEY_ID`]: cfg.accessKeyId,
    [`${R}_SECRET_ACCESS_KEY`]: cfg.secretAccessKey,
    // Buckets already exist (off-site: operator-created, Garage: admin API) —
    // don't need CreateBucket rights, and R2 rejects the probe.
    [`${R}_NO_CHECK_BUCKET`]: 'true',
  };
  if (cfg.endpoint) env[`${R}_ENDPOINT`] = cfg.endpoint;
  if (cfg.region) env[`${R}_REGION`] = cfg.region;
  if (provider === 'Other') env[`${R}_FORCE_PATH_STYLE`] = 'true';
  return env;
}
