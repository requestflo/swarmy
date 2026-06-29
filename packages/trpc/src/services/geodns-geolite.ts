/**
 * GeoLite2 (MaxMind) provisioning for the CoreDNS GSLB service — pure, IO-free.
 *
 * CoreDNS's `geoip` plugin needs a `GeoLite2-City.mmdb` on disk to do per-query
 * geo steering. swarmy makes that db available in one of two Docker-native ways,
 * and OTHERWISE degrades gracefully: when neither is configured the `geoip` block
 * is omitted from the Corefile so CoreDNS still starts and answers by round-robin
 * (`loadbalance`) instead of crash-looping on a missing db.
 *
 *   A. CONFIG MOUNT (`mmdbConfigRef`) — an operator-created Docker config holding
 *      the .mmdb bytes is mounted read-only at the geoip path. Docker is the
 *      source of truth for the blob (skill: "binary blob a service consumes at
 *      start → Docker config"), never Postgres. Create it once per swarm with:
 *        docker config create swarmy-geolite2 GeoLite2-City.mmdb
 *
 *   B. LICENSE INIT (`maxmindLicenseSecretRef`) — a tiny global init service
 *      downloads the db using a MaxMind license key read from a Docker SECRET
 *      (exposed to the downloader as `MAXMIND_LICENSE_KEY`) into a per-node
 *      volume that CoreDNS mounts. The license key is NEVER stored in the DB or a
 *      label; `settings` holds only the secret's NAME.
 *
 * `GeoDnsConfig.settings` therefore carries only *references* (config / secret
 * names), so this whole module is pure and the secret-handling rules hold.
 */

export const GEOLITE_MMDB_FILENAME = 'GeoLite2-City.mmdb';
/** Path the `geoip` plugin reads in CONFIG-mount mode (and the legacy default). */
export const DEFAULT_MMDB_PATH = `/etc/coredns/${GEOLITE_MMDB_FILENAME}`;
/** Per-node volume populated by the license-init downloader (Mode B). */
export const GEOLITE_VOLUME = 'swarmy-geolite2';
export const GEOLITE_VOLUME_DIR = '/etc/coredns/geoip';
export const GEOLITE_INIT_SERVICE = 'swarmy-geolite2-init';
/** Small image with a shell + busybox (we `apk add curl` at runtime, best-effort). */
export const GEOLITE_INIT_IMAGE = 'alpine:3.20';

/** Parsed shape of `GeoDnsConfig.settings` (a Json column). All fields optional. */
export interface GeoDnsSettings {
  /** Docker config name holding GeoLite2-City.mmdb (Mode A). */
  mmdbConfigRef?: string;
  /** Docker secret name holding the MaxMind license key (Mode B). */
  maxmindLicenseSecretRef?: string;
  /** Provider zone id (Cloudflare zone id / Route53 hosted zone id). */
  providerZoneId?: string;
  /**
   * Name of the controller env var holding the provider API token / AWS creds.
   * The value lives in the controller's secret-injected environment, never the
   * DB. Defaults per provider (see resolveProviderToken).
   */
  providerTokenEnv?: string;
  /** Route53 signing region (default us-east-1). Ignored by Cloudflare. */
  providerRegion?: string;
}

/** Coerce an opaque Json value into {@link GeoDnsSettings}. Never throws. */
export function parseGeoDnsSettings(raw: unknown): GeoDnsSettings {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    mmdbConfigRef: str(o.mmdbConfigRef),
    maxmindLicenseSecretRef: str(o.maxmindLicenseSecretRef),
    providerZoneId: str(o.providerZoneId),
    providerTokenEnv: str(o.providerTokenEnv),
    providerRegion: str(o.providerRegion),
  };
}

/** How the GeoLite2 db will be (or won't be) made available to CoreDNS. */
export type GeoLitePlan =
  | { mode: 'config'; mmdbPath: string; configRef: string }
  | {
      mode: 'license';
      mmdbPath: string;
      volume: string;
      volumeDir: string;
      licenseSecretRef: string;
    }
  | { mode: 'none'; mmdbPath: string };

/**
 * Decide the GeoLite2 strategy from settings. CONFIG mount wins over LICENSE init
 * when both are present (the prebuilt db is authoritative and race-free).
 */
export function resolveGeoLite(settings: GeoDnsSettings | null | undefined): GeoLitePlan {
  if (settings?.mmdbConfigRef) {
    return { mode: 'config', mmdbPath: DEFAULT_MMDB_PATH, configRef: settings.mmdbConfigRef };
  }
  if (settings?.maxmindLicenseSecretRef) {
    return {
      mode: 'license',
      mmdbPath: `${GEOLITE_VOLUME_DIR}/${GEOLITE_MMDB_FILENAME}`,
      volume: GEOLITE_VOLUME,
      volumeDir: GEOLITE_VOLUME_DIR,
      licenseSecretRef: settings.maxmindLicenseSecretRef,
    };
  }
  return { mode: 'none', mmdbPath: DEFAULT_MMDB_PATH };
}

/** Whether the `geoip` plugin can be enabled (i.e. the mmdb will be present). */
export const geoipEnabled = (plan: GeoLitePlan): boolean => plan.mode !== 'none';

/**
 * The download/refresh script for the Mode-B init service. Reads the license key
 * from the mounted Docker secret (falling back to the MAXMIND_LICENSE_KEY env),
 * fetches + extracts the City db into the shared volume, then refreshes daily.
 * Pure string builder so it is golden-testable.
 */
export function geoliteInitScript(licenseSecretRef: string, volumeDir: string): string {
  const secretPath = `/run/secrets/${licenseSecretRef}`;
  return [
    'set -eu',
    'apk add --no-cache curl tar >/dev/null 2>&1 || true',
    `KEY="$(cat ${secretPath} 2>/dev/null || printf '%s' "\${MAXMIND_LICENSE_KEY:-}")"`,
    'while :; do',
    '  if [ -n "$KEY" ]; then',
    '    url="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&suffix=tar.gz&license_key=$KEY"',
    '    if curl -fsSL "$url" -o /tmp/geo.tgz; then',
    '      tar -xzf /tmp/geo.tgz -C /tmp &&',
    `        cp /tmp/GeoLite2-City_*/${GEOLITE_MMDB_FILENAME} ${volumeDir}/${GEOLITE_MMDB_FILENAME} &&`,
    `        echo "geolite: refreshed ${volumeDir}/${GEOLITE_MMDB_FILENAME}";`,
    '    else echo "geolite: download failed"; fi',
    '  else echo "geolite: no license key"; fi',
    '  sleep 86400',
    'done',
  ].join('\n');
}
