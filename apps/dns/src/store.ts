import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DnsSnapshotBundle } from '@swarmy/core/protocol';
import { log, logError } from './config';

/**
 * Snapshot store — the locally persisted zone truth. The controller pushes
 * versioned bundles via the admin API; we persist atomically and keep serving
 * the last good bundle through controller outages and our own restarts
 * (invariant #4, geo-edge-routing skill).
 */
export class SnapshotStore {
  private bundle: DnsSnapshotBundle | undefined;
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'snapshot.json');
  }

  get current(): DnsSnapshotBundle | undefined {
    return this.bundle;
  }

  get version(): number {
    return this.bundle?.version ?? -1;
  }

  /** Load the persisted bundle at boot (missing/corrupt file = start empty). */
  async load(): Promise<void> {
    try {
      const raw = await Bun.file(this.path).json();
      const parsed = DnsSnapshotBundle.safeParse(raw);
      if (parsed.success) {
        this.bundle = parsed.data;
        log(`loaded persisted snapshot v${parsed.data.version} (${parsed.data.zones.length} zones)`);
      } else {
        logError('persisted snapshot failed validation — starting empty', parsed.error.message);
      }
    } catch {
      log('no persisted snapshot — starting empty');
    }
  }

  /**
   * Apply a pushed bundle. Rejects non-monotonic versions (out-of-order or
   * replayed pushes are harmless no-ops). Returns the outcome for the admin
   * API response.
   */
  async apply(
    candidate: unknown,
  ): Promise<{ ok: true; version: number; zones: number } | { ok: false; error: string }> {
    const parsed = DnsSnapshotBundle.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, error: `invalid bundle: ${parsed.error.message}` };
    }
    const next = parsed.data;
    if (this.bundle && next.version <= this.bundle.version) {
      return {
        ok: false,
        error: `stale version ${next.version} (serving ${this.bundle.version})`,
      };
    }
    await this.persist(next);
    this.bundle = next;
    log(`applied snapshot v${next.version} (${next.zones.length} zones)`);
    return { ok: true, version: next.version, zones: next.zones.length };
  }

  /** Atomic write: tmp file + rename so a crash never leaves a torn snapshot. */
  private async persist(bundle: DnsSnapshotBundle): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await Bun.write(tmp, JSON.stringify(bundle));
    await rename(tmp, this.path);
  }
}
