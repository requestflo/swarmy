import type { LatLon } from '@swarmy/dns';

/**
 * The GeoIP database BUNDLED in the swarmy-dns image (apps/dns/Dockerfile):
 * DB-IP "IP to Country Lite", CC BY 4.0 — attribution required and carried in
 * the image (`/usr/share/swarmy-dns/geoip/NOTICE`, OCI labels) and the
 * dashboard. It is the offline floor: a fresh edge node with no egress still
 * steers by country, and the online refresh (`dbip` city / `maxmind`) stays an
 * optional upgrade on top — never a requirement.
 *
 * Pure (no I/O) so the selection + location rules are unit-testable.
 */

export const BUNDLED_GEOIP_PATH = '/usr/share/swarmy-dns/geoip/dbip-country-lite.mmdb';

export type GeoIpSourceMode = 'dbip' | 'maxmind' | 'file' | 'off';

/**
 * Ordered on-disk candidates to serve at boot, best first. The downloaded
 * (city) copy on the volume beats the bundled (country) copy; the operator's
 * `file` beats both. The bundled copy is ALWAYS last, so a missing download or
 * a missing operator file degrades to country-level steering, not none.
 */
export function geoipCandidatePaths(opts: {
  source: GeoIpSourceMode;
  downloadedPath: string;
  operatorFile: string | undefined;
  bundledPath: string | undefined;
}): string[] {
  if (opts.source === 'off') return [];
  const first = opts.source === 'file' ? opts.operatorFile : opts.downloadedPath;
  return [first, opts.bundledPath].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
}

/** The slice of an mmdb record (city OR country edition) steering needs. */
export interface GeoRecordLike {
  location?: { latitude?: number; longitude?: number } | undefined;
  country?: { iso_code?: string } | undefined;
  registered_country?: { iso_code?: string } | undefined;
  continent?: { code?: string } | undefined;
}

/**
 * Record → coordinates. City editions carry `location`; the country edition
 * does not, so fall back to a representative point for the country, then the
 * continent. Undefined only when the record says nothing usable.
 */
export function locateRecord(rec: GeoRecordLike | null | undefined): LatLon | undefined {
  if (!rec) return undefined;
  const loc = rec.location;
  if (typeof loc?.latitude === 'number' && typeof loc.longitude === 'number') {
    return { lat: loc.latitude, lon: loc.longitude };
  }
  const iso = (rec.country?.iso_code ?? rec.registered_country?.iso_code)?.toUpperCase();
  if (iso && COUNTRY_POINTS[iso]) return COUNTRY_POINTS[iso];
  const cont = rec.continent?.code?.toUpperCase();
  if (cont && CONTINENT_POINTS[cont]) return CONTINENT_POINTS[cont];
  return undefined;
}

/** Continent codes as used by DB-IP / MaxMind (AF AN AS EU NA OC SA). */
export const CONTINENT_POINTS: Record<string, LatLon> = {
  AF: { lat: 2.0, lon: 21.0 },
  AN: { lat: -75.0, lon: 0.0 },
  AS: { lat: 30.0, lon: 100.0 },
  EU: { lat: 50.0, lon: 10.0 },
  NA: { lat: 40.0, lon: -95.0 },
  OC: { lat: -25.0, lon: 135.0 },
  SA: { lat: -15.0, lon: -60.0 },
};

/**
 * Representative point per country — the main population centre (not the
 * geometric centroid, which for large countries lands far from the users).
 * Countries missing here fall back to their continent.
 */
export const COUNTRY_POINTS: Record<string, LatLon> = {
  // North America
  US: { lat: 37.4, lon: -92.2 },
  CA: { lat: 45.5, lon: -76.0 },
  MX: { lat: 19.4, lon: -99.1 },
  GT: { lat: 14.6, lon: -90.5 },
  CR: { lat: 9.9, lon: -84.1 },
  PA: { lat: 9.0, lon: -79.5 },
  CU: { lat: 23.1, lon: -82.4 },
  DO: { lat: 18.5, lon: -69.9 },
  PR: { lat: 18.4, lon: -66.1 },
  JM: { lat: 18.0, lon: -76.8 },
  // South America
  BR: { lat: -23.5, lon: -46.6 },
  AR: { lat: -34.6, lon: -58.4 },
  CL: { lat: -33.4, lon: -70.7 },
  CO: { lat: 4.7, lon: -74.1 },
  PE: { lat: -12.0, lon: -77.0 },
  VE: { lat: 10.5, lon: -66.9 },
  EC: { lat: -0.2, lon: -78.5 },
  UY: { lat: -34.9, lon: -56.2 },
  PY: { lat: -25.3, lon: -57.6 },
  BO: { lat: -16.5, lon: -68.1 },
  // Europe
  GB: { lat: 51.5, lon: -0.1 },
  IE: { lat: 53.3, lon: -6.3 },
  FR: { lat: 48.9, lon: 2.4 },
  DE: { lat: 50.1, lon: 8.7 },
  NL: { lat: 52.4, lon: 4.9 },
  BE: { lat: 50.8, lon: 4.4 },
  LU: { lat: 49.6, lon: 6.1 },
  CH: { lat: 47.4, lon: 8.5 },
  AT: { lat: 48.2, lon: 16.4 },
  ES: { lat: 40.4, lon: -3.7 },
  PT: { lat: 38.7, lon: -9.1 },
  IT: { lat: 45.5, lon: 9.2 },
  DK: { lat: 55.7, lon: 12.6 },
  NO: { lat: 59.9, lon: 10.8 },
  SE: { lat: 59.3, lon: 18.1 },
  FI: { lat: 60.2, lon: 24.9 },
  IS: { lat: 64.1, lon: -21.9 },
  PL: { lat: 52.2, lon: 21.0 },
  CZ: { lat: 50.1, lon: 14.4 },
  SK: { lat: 48.1, lon: 17.1 },
  HU: { lat: 47.5, lon: 19.0 },
  RO: { lat: 44.4, lon: 26.1 },
  BG: { lat: 42.7, lon: 23.3 },
  GR: { lat: 38.0, lon: 23.7 },
  HR: { lat: 45.8, lon: 16.0 },
  SI: { lat: 46.1, lon: 14.5 },
  RS: { lat: 44.8, lon: 20.5 },
  BA: { lat: 43.9, lon: 18.4 },
  AL: { lat: 41.3, lon: 19.8 },
  MK: { lat: 42.0, lon: 21.4 },
  ME: { lat: 42.4, lon: 19.3 },
  EE: { lat: 59.4, lon: 24.8 },
  LV: { lat: 56.9, lon: 24.1 },
  LT: { lat: 54.7, lon: 25.3 },
  UA: { lat: 50.5, lon: 30.5 },
  BY: { lat: 53.9, lon: 27.6 },
  MD: { lat: 47.0, lon: 28.9 },
  RU: { lat: 55.8, lon: 37.6 },
  TR: { lat: 41.0, lon: 29.0 },
  CY: { lat: 35.2, lon: 33.4 },
  MT: { lat: 35.9, lon: 14.5 },
  // Middle East
  IL: { lat: 32.1, lon: 34.8 },
  AE: { lat: 25.2, lon: 55.3 },
  SA: { lat: 24.7, lon: 46.7 },
  QA: { lat: 25.3, lon: 51.5 },
  BH: { lat: 26.2, lon: 50.6 },
  KW: { lat: 29.4, lon: 48.0 },
  OM: { lat: 23.6, lon: 58.4 },
  JO: { lat: 31.9, lon: 35.9 },
  LB: { lat: 33.9, lon: 35.5 },
  IQ: { lat: 33.3, lon: 44.4 },
  IR: { lat: 35.7, lon: 51.4 },
  // Africa
  ZA: { lat: -26.2, lon: 28.0 },
  NG: { lat: 6.5, lon: 3.4 },
  EG: { lat: 30.0, lon: 31.2 },
  KE: { lat: -1.3, lon: 36.8 },
  MA: { lat: 33.6, lon: -7.6 },
  DZ: { lat: 36.8, lon: 3.1 },
  TN: { lat: 36.8, lon: 10.2 },
  GH: { lat: 5.6, lon: -0.2 },
  ET: { lat: 9.0, lon: 38.7 },
  TZ: { lat: -6.8, lon: 39.3 },
  UG: { lat: 0.3, lon: 32.6 },
  SN: { lat: 14.7, lon: -17.4 },
  CI: { lat: 5.3, lon: -4.0 },
  AO: { lat: -8.8, lon: 13.2 },
  // Asia
  CN: { lat: 31.2, lon: 121.5 },
  HK: { lat: 22.3, lon: 114.2 },
  TW: { lat: 25.0, lon: 121.5 },
  JP: { lat: 35.7, lon: 139.7 },
  KR: { lat: 37.6, lon: 127.0 },
  IN: { lat: 19.1, lon: 72.9 },
  PK: { lat: 24.9, lon: 67.0 },
  BD: { lat: 23.8, lon: 90.4 },
  LK: { lat: 6.9, lon: 79.9 },
  NP: { lat: 27.7, lon: 85.3 },
  SG: { lat: 1.3, lon: 103.8 },
  MY: { lat: 3.1, lon: 101.7 },
  ID: { lat: -6.2, lon: 106.8 },
  TH: { lat: 13.8, lon: 100.5 },
  VN: { lat: 10.8, lon: 106.7 },
  PH: { lat: 14.6, lon: 121.0 },
  KH: { lat: 11.6, lon: 104.9 },
  MM: { lat: 16.8, lon: 96.2 },
  KZ: { lat: 43.2, lon: 76.9 },
  UZ: { lat: 41.3, lon: 69.3 },
  MN: { lat: 47.9, lon: 106.9 },
  GE: { lat: 41.7, lon: 44.8 },
  AM: { lat: 40.2, lon: 44.5 },
  AZ: { lat: 40.4, lon: 49.9 },
  // Oceania
  AU: { lat: -33.9, lon: 151.2 },
  NZ: { lat: -36.8, lon: 174.8 },
  FJ: { lat: -18.1, lon: 178.4 },
  PG: { lat: -9.4, lon: 147.2 },
};
