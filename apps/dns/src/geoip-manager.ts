import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Reader, type CityResponse } from 'mmdb-lib';
import type { GeoIpReader, LatLon } from '@swarmy/dns';
import { log, logError, type DnsServerConfig } from './config';

/**
 * GeoIP database lifecycle. Sources (SWARMY_DNS_GEOIP):
 *
 * - `dbip` (default): DB-IP Lite city mmdb — free, NO signup/key, CC BY 4.0
 *   (attribution surfaced in the dashboard). Downloaded on boot, re-checked
 *   weekly (new editions land monthly).
 * - `maxmind`: GeoLite2-City via the license key mounted at
 *   /run/secrets/maxmind-license (higher accuracy, operator opt-in).
 * - `file`: operator-provisioned mmdb at SWARMY_DNS_GEOIP_FILE (air-gapped).
 * - `off`: no geo steering (deterministic answers).
 *
 * Failure posture: keep last-good on refresh errors; serve WITHOUT geo until
 * the first success. A missing DB degrades steering, never resolution.
 */

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly re-check
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // hourly until first success

export class GeoIpManager implements GeoIpReader {
  private reader: Reader<CityResponse> | undefined;
  private loadedAt: string | undefined;
  private source: string;
  private lastError: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly dbPath: string;

  constructor(private readonly config: DnsServerConfig) {
    this.source = config.geoipSource;
    this.dbPath = join(config.dataDir, 'geoip', 'city.mmdb');
  }

  lookup(ip: string): LatLon | undefined {
    if (!this.reader) return undefined;
    try {
      const city = this.reader.get(ip);
      const location = city?.location;
      if (location?.latitude === undefined || location.longitude === undefined) return undefined;
      return { lat: location.latitude, lon: location.longitude };
    } catch {
      return undefined;
    }
  }

  /** Reader accessor for the query pipeline (undefined until first load). */
  current(): GeoIpReader | undefined {
    return this.reader ? this : undefined;
  }

  status(): {
    source: string;
    loaded: boolean;
    loadedAt: string | undefined;
    lastError: string | undefined;
  } {
    return {
      source: this.source,
      loaded: this.reader !== undefined,
      loadedAt: this.loadedAt,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.config.geoipSource === 'off') {
      log('geoip disabled (SWARMY_DNS_GEOIP=off)');
      return;
    }
    // Serve whatever we already have on disk immediately…
    await this.loadFromDisk();
    // …then refresh in the background, forever.
    void this.refreshLoop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async refreshLoop(): Promise<void> {
    const ok = await this.refresh();
    this.timer = setTimeout(
      () => void this.refreshLoop(),
      ok || this.reader ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS,
    );
  }

  private async loadFromDisk(): Promise<void> {
    const path = this.config.geoipSource === 'file' ? this.config.geoipFile : this.dbPath;
    if (!path) return;
    try {
      const buf = Buffer.from(await Bun.file(path).arrayBuffer());
      this.swap(buf, `disk:${path}`);
    } catch {
      // nothing on disk yet — fine
    }
  }

  private async refresh(): Promise<boolean> {
    try {
      switch (this.config.geoipSource) {
        case 'file':
          await this.loadFromDisk();
          return this.reader !== undefined;
        case 'dbip':
          return await this.refreshDbIp();
        case 'maxmind':
          return await this.refreshMaxMind();
        default:
          return false;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logError('geoip refresh failed (keeping last-good):', this.lastError);
      return false;
    }
  }

  /** DB-IP Lite: current month's edition, falling back to last month's. */
  private async refreshDbIp(): Promise<boolean> {
    const now = new Date();
    const candidates = [0, 1].map((back) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      return `https://download.db-ip.com/free/dbip-city-lite-${ym}.mmdb.gz`;
    });
    for (const url of candidates) {
      const res = await fetch(url);
      if (!res.ok) continue;
      const gz = Buffer.from(await res.arrayBuffer());
      const mmdb = Buffer.from(Bun.gunzipSync(gz));
      await this.persistAndSwap(mmdb, url);
      return true;
    }
    this.lastError = 'no DB-IP Lite edition reachable';
    return false;
  }

  /** MaxMind GeoLite2-City with the operator's license key (Docker secret). */
  private async refreshMaxMind(): Promise<boolean> {
    const key =
      process.env.MAXMIND_LICENSE_KEY ??
      (await Bun.file('/run/secrets/maxmind-license')
        .text()
        .then((t) => t.trim())
        .catch(() => undefined));
    if (!key) {
      this.lastError = 'maxmind mode but no license key (secret maxmind-license)';
      return false;
    }
    const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      this.lastError = `maxmind download failed: ${res.status}`;
      return false;
    }
    // Tarball: GeoLite2-City_YYYYMMDD/GeoLite2-City.mmdb — extract via tar.
    const tmpDir = join(this.config.dataDir, 'geoip', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tarPath = join(tmpDir, 'geolite2.tar.gz');
    await Bun.write(tarPath, await res.arrayBuffer());
    const proc = Bun.spawn(
      ['tar', '-xzf', tarPath, '-C', tmpDir, '--strip-components=1', '--wildcards', '*/GeoLite2-City.mmdb'],
      { stderr: 'pipe' },
    );
    if ((await proc.exited) !== 0) {
      this.lastError = `tar extract failed: ${await new Response(proc.stderr).text()}`;
      return false;
    }
    const mmdb = Buffer.from(await Bun.file(join(tmpDir, 'GeoLite2-City.mmdb')).arrayBuffer());
    await this.persistAndSwap(mmdb, 'maxmind:GeoLite2-City');
    return true;
  }

  private async persistAndSwap(mmdb: Buffer, source: string): Promise<void> {
    // Validate BEFORE persisting — a bad download must not poison the volume.
    this.swap(mmdb, source);
    await mkdir(join(this.config.dataDir, 'geoip'), { recursive: true });
    const tmp = `${this.dbPath}.tmp`;
    await Bun.write(tmp, mmdb);
    await rename(tmp, this.dbPath);
  }

  private swap(mmdb: Buffer, source: string): void {
    const reader = new Reader<CityResponse>(mmdb); // throws on invalid data
    this.reader = reader;
    this.loadedAt = new Date().toISOString();
    this.source = `${this.config.geoipSource} (${source})`;
    this.lastError = undefined;
    log(`geoip database loaded from ${source} (${(mmdb.byteLength / 1024 / 1024).toFixed(1)} MiB)`);
  }
}
