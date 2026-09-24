import { existsSync, readFileSync } from 'node:fs';
import { Reader, type CountryResponse } from 'mmdb-lib';

/**
 * IP → ISO country for analytics, from swarmy's own GeoIP (DB-IP Country
 * Lite, CC BY 4.0 — the same database the swarmy-dns image bundles; MaxMind
 * GeoLite2 works too). The IP is looked up and dropped: only the two-letter
 * code is stored. No database on disk ⇒ '' ("unknown"), never an error.
 *
 * Candidates: SWARMY_RUM_GEOIP_FILE, then the bundled paths.
 */
export const RUM_GEOIP_CANDIDATES = [
  '/usr/share/swarmy/geoip/dbip-country-lite.mmdb',
  '/usr/share/swarmy-dns/geoip/dbip-country-lite.mmdb',
];

type CountryRecord = CountryResponse;

let reader: Reader<CountryRecord> | null | undefined;

function load(): Reader<CountryRecord> | null {
  if (reader !== undefined) return reader;
  const paths = [process.env.SWARMY_RUM_GEOIP_FILE, ...RUM_GEOIP_CANDIDATES].filter((p): p is string => Boolean(p));
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        reader = new Reader<CountryRecord>(readFileSync(p));
        return reader;
      }
    } catch {
      /* try the next */
    }
  }
  reader = null;
  return reader;
}

export function countryOf(ip: string): string {
  if (!ip) return '';
  try {
    const rec = load()?.get(ip.replace(/^::ffff:/, ''));
    const cc = rec?.country?.iso_code ?? rec?.registered_country?.iso_code ?? '';
    return /^[A-Z]{2}$/.test(cc) ? cc : '';
  } catch {
    return '';
  }
}

/** Is a GeoIP database loaded (for the UI's honesty line)? */
export function geoipAvailable(): boolean {
  return load() !== null;
}
