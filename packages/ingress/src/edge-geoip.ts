import { z } from 'zod';
import { isStockCaddyImage } from './drivers/caddy';

/**
 * The country database the edge's country rules (`countryAllow` /
 * `countryDeny`, the maxmind_geolocation matcher) read — pure.
 *
 * swarmy's Caddy build bundles DB-IP "IP to Country Lite" (CC BY 4.0) with the
 * same fetch the swarmy-dns image uses (docker/caddy-swarmy/geoip), so country
 * rules work out of the box on a fresh edge with no egress. The org setting
 * picks between that bundled copy (default), an operator mmdb already inside
 * the edge container (`file`), and `off` (rules saved, never enforced).
 *
 * Without a usable path the renderer emits NOTHING for country rules and
 * validate() warns — a half-configured geo rule degrades to "not enforced",
 * never a lockout.
 */

/** Where the swarmy Caddy image carries the bundled country database. */
export const EDGE_GEOIP_BUNDLED_PATH = '/usr/share/swarmy/geoip/dbip-country-lite.mmdb';
/** CC BY 4.0 attribution — required wherever the bundled database is used. */
export const EDGE_GEOIP_ATTRIBUTION = 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0';

export const EDGE_GEOIP_MODES = ['bundled', 'file', 'off'] as const;
export type EdgeGeoipMode = (typeof EDGE_GEOIP_MODES)[number];

/** An absolute path inside the edge container (no spaces: it lands in the Caddyfile). */
export const EdgeGeoipPathSchema = z.string().regex(/^\/[A-Za-z0-9_./-]+\.mmdb$/, 'an absolute path to a .mmdb file');

export const EdgeGeoipSettingSchema = z.object({
  mode: z.enum(EDGE_GEOIP_MODES),
  /** Operator mmdb path (mode `file`). */
  path: EdgeGeoipPathSchema.optional(),
});
export type EdgeGeoipSetting = z.infer<typeof EdgeGeoipSettingSchema>;

export interface EdgeGeoipResolution {
  /** The mmdb path to render with; '' = country rules are not enforced. */
  path: string;
  /** Why: the bundled copy, an operator file, off, or no usable database. */
  source: 'bundled' | 'file' | 'off' | 'unavailable';
}

/**
 * The path the edge renders country rules with. A raw `extraConfig.geoipMmdbPath`
 * the operator set before this setting existed keeps winning while the
 * setting is untouched. The bundled copy needs swarmy's Caddy build — a stock
 * image has neither the matcher nor the file.
 */
export function resolveEdgeGeoip(input: {
  setting?: EdgeGeoipSetting | null;
  image: string;
  legacyPath?: unknown;
}): EdgeGeoipResolution {
  const s = input.setting;
  if (!s && typeof input.legacyPath === 'string' && input.legacyPath !== '') {
    return { path: input.legacyPath, source: 'file' };
  }
  const mode = s?.mode ?? 'bundled';
  if (mode === 'off') return { path: '', source: 'off' };
  if (mode === 'file') {
    return s?.path && EdgeGeoipPathSchema.safeParse(s.path).success
      ? { path: s.path, source: 'file' }
      : { path: '', source: 'unavailable' };
  }
  return isStockCaddyImage(input.image)
    ? { path: '', source: 'unavailable' }
    : { path: EDGE_GEOIP_BUNDLED_PATH, source: 'bundled' };
}

/** Coerce a persisted setting (tolerant: junk reads as "not set"). */
export function readEdgeGeoipSetting(raw: unknown): EdgeGeoipSetting | null {
  const parsed = EdgeGeoipSettingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
