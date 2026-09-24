import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { Reader, type CityResponse } from 'mmdb-lib';
import type { GeoIpReader, LatLon } from '@swarmy/dns';
import { log, logError, type DnsServerConfig } from './config';
import { geoipCandidatePaths, locateRecord } from './geoip-fallback';

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
 * Offline floor: the image BUNDLES DB-IP Country Lite (CC BY 4.0, see
 * geoip-fallback.ts / apps/dns/Dockerfile). Whenever no downloaded (or
 * operator) mmdb is on disk, that copy is served — country-level steering on a
 * fresh node with no egress. The online refresh is an optional upgrade on top.
 *
 * Failure posture: keep last-good on refresh errors; serve WITHOUT geo until
 * the first success. A missing DB degrades steering, never resolution.
 *
 * Memory: the city DB is ~120 MiB. It is streamed (gunzip on the fly) to disk
 * and MEMORY-MAPPED, never read into the heap — file-backed pages the kernel
 * can reclaim, not ~400 MiB of anon RSS that got the process OOM-killed on a
 * 1 GB edge node. A fresh copy on disk skips the download at boot.
 */

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly re-check
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // hourly until first success
/** A stalled download fails the refresh (keeps last-good) instead of hanging it. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
      // City editions carry `location`; the bundled country edition resolves
      // via a representative point per country/continent.
      return locateRecord(this.reader.get(ip));
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
    const candidates = geoipCandidatePaths({
      source: this.config.geoipSource,
      downloadedPath: this.dbPath,
      operatorFile: this.config.geoipFile,
      bundledPath: this.config.geoipBundledFile,
    });
    for (const path of candidates) {
      try {
        const label = path === this.config.geoipBundledFile ? `bundled:${path}` : `disk:${path}`;
        this.swap(mapFile(path), label);
        return;
      } catch {
        // not there (or unreadable) — try the next candidate
      }
    }
  }

  /** The on-disk copy is recent enough that a boot needn't re-download it. */
  private async diskIsFresh(): Promise<boolean> {
    if (!this.reader) return false;
    const st = await stat(this.dbPath).catch(() => undefined);
    return st !== undefined && Date.now() - st.mtimeMs < REFRESH_INTERVAL_MS;
  }

  private async refresh(): Promise<boolean> {
    try {
      switch (this.config.geoipSource) {
        case 'file':
          await this.loadFromDisk();
          return this.reader !== undefined;
        case 'dbip':
          return (await this.diskIsFresh()) || (await this.refreshDbIp());
        case 'maxmind':
          return (await this.diskIsFresh()) || (await this.refreshMaxMind());
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
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) continue;
      const tmp = await this.tmpPath();
      // node:zlib, not DecompressionStream: Bun.write() of a piped web stream hangs.
      await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(tmp));
      await this.adopt(tmp, url);
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
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      this.lastError = `maxmind download failed: ${res.status}`;
      return false;
    }
    // Tarball: GeoLite2-City_YYYYMMDD/GeoLite2-City.mmdb — extract via tar.
    const tmpDir = join(this.config.dataDir, 'geoip', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tarPath = join(tmpDir, 'geolite2.tar.gz');
    // node streams: Bun.write(path, Response) hangs on linux-arm64.
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tarPath));
    const proc = Bun.spawn(
      ['tar', '-xzf', tarPath, '-C', tmpDir, '--strip-components=1', '--wildcards', '*/GeoLite2-City.mmdb'],
      { stderr: 'pipe' },
    );
    if ((await proc.exited) !== 0) {
      this.lastError = `tar extract failed: ${await new Response(proc.stderr).text()}`;
      return false;
    }
    await rm(tarPath, { force: true });
    await this.adopt(join(tmpDir, 'GeoLite2-City.mmdb'), 'maxmind:GeoLite2-City');
    return true;
  }

  private async tmpPath(): Promise<string> {
    await mkdir(join(this.config.dataDir, 'geoip'), { recursive: true });
    return `${this.dbPath}.tmp`;
  }

  /**
   * Validate a downloaded DB BEFORE it replaces the last-good copy (a bad
   * download must not poison the volume), then rename it into place. The
   * mapping survives the rename (same inode); the old DB's inode is freed
   * once its mapping is collected — never overwritten in place while mapped.
   */
  private async adopt(file: string, source: string): Promise<void> {
    try {
      this.swap(mapFile(file), source);
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
    await rename(file, this.dbPath);
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

/** Memory-map an mmdb read-only as a zero-copy Buffer view (file-backed pages). */
function mapFile(path: string): Buffer {
  const view = Bun.mmap(path, { shared: false });
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}
