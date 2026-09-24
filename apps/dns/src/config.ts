/**
 * swarmy-dns configuration — all env, parsed once at boot.
 *
 * Deployed by the controller as a global service on ingress+outlet nodes
 * (see dns-deploy.service.ts); env here must stay in sync with that spec.
 */

import { BUNDLED_GEOIP_PATH } from './geoip-fallback';
import { parseListenOverride } from './listen';

export type GeoIpSource = 'dbip' | 'maxmind' | 'file' | 'off';

export interface DnsServerConfig {
  /** DNS listen port (udp+tcp). 53 in production, high port for local dev. */
  port: number;
  /** Admin API port (snapshot push + status). */
  adminPort: number;
  /**
   * Explicit DNS listen addresses (`SWARMY_DNS_LISTEN`, comma list; legacy
   * `SWARMY_DNS_HOST` as a single address). Undefined = auto: bind every
   * non-loopback, non-link-local host address individually (listen.ts) —
   * never the wildcard, which collides with systemd-resolved's stub.
   */
  listen: string[] | undefined;
  /**
   * Explicit admin API listen addresses (`SWARMY_DNS_ADMIN_LISTEN`).
   * Undefined = auto: 127.0.0.1 + the docker0 bridge address. Never public.
   */
  adminListen: string[] | undefined;
  /** Interface re-scan period (ms) — picks up DHCP / floating-IP changes. */
  rescanMs: number;
  /** Persistent state dir (named volume in production). */
  dataDir: string;
  geoipSource: GeoIpSource;
  /** file mode: path to a pre-provisioned mmdb. */
  geoipFile: string | undefined;
  /**
   * The mmdb baked into the image (DB-IP Country Lite, CC BY 4.0) — served
   * whenever no downloaded/operator file is present. `SWARMY_DNS_GEOIP_BUNDLED`
   * overrides; empty disables the fallback.
   */
  geoipBundledFile: string | undefined;
  /** Bearer token for the admin API (undefined = fail closed unless insecure). */
  adminToken: string | undefined;
  /** Local-dev escape hatch: allow snapshot pushes without a token. */
  allowInsecureAdmin: boolean;
}

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

async function readSecretFile(path: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(path).text();
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function loadConfig(): Promise<DnsServerConfig> {
  const env = process.env;
  const source = (env.SWARMY_DNS_GEOIP ?? 'dbip') as GeoIpSource;
  return {
    port: int(env.SWARMY_DNS_PORT, 53),
    adminPort: int(env.SWARMY_DNS_ADMIN_PORT, 53535),
    listen: parseListenOverride(env.SWARMY_DNS_LISTEN ?? env.SWARMY_DNS_HOST),
    adminListen: parseListenOverride(env.SWARMY_DNS_ADMIN_LISTEN),
    rescanMs: int(env.SWARMY_DNS_RESCAN_MS, 30_000),
    dataDir: env.SWARMY_DNS_DATA_DIR ?? '/var/lib/swarmy-dns',
    geoipSource: ['dbip', 'maxmind', 'file', 'off'].includes(source) ? source : 'dbip',
    geoipFile: env.SWARMY_DNS_GEOIP_FILE,
    geoipBundledFile:
      env.SWARMY_DNS_GEOIP_BUNDLED === undefined ? BUNDLED_GEOIP_PATH : env.SWARMY_DNS_GEOIP_BUNDLED || undefined,
    adminToken:
      env.SWARMY_DNS_ADMIN_TOKEN ??
      (await readSecretFile('/run/secrets/swarmy-dns-admin')),
    allowInsecureAdmin: env.SWARMY_DNS_ALLOW_INSECURE_ADMIN === '1',
  };
}

export function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[swarmy-dns]', ...args);
}

export function logError(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error('[swarmy-dns]', ...args);
}
