/**
 * Litestream (v0.5.x) for control.db: the config it runs with, restore, and
 * a supervised `replicate` child process.
 *
 * Why a supervised child and not `litestream replicate -exec <controller>`:
 * the fence. When the lease is lost, the controller must stop Litestream
 * WITHOUT its final sync (SIGKILL), because the new holder may already own the
 * replica. On a clean shutdown it does the opposite: it stops writes, then
 * sends SIGTERM so Litestream ships the tail (`shutdown-sync-timeout`), then
 * releases the lease. `-exec` can't tell those two cases apart.
 *
 * Credentials never touch disk. The config file holds only the endpoint,
 * bucket and path. The keys ride in the child's env as
 * LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY, which v0.5 reads
 * natively.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Subprocess } from 'bun';
import type { ReplicaTarget, StorePaths } from './config';
import { clearSidecarFiles, litestreamPath } from './replica';

export const LITESTREAM_VERSION = '0.5.17';

/** One replica per DB: Litestream v0.5 accepts a single `replica`. */
export function renderLitestreamConfig(input: { dbPath: string; target: ReplicaTarget; socketPath: string }): string {
  const { dbPath, target, socketPath } = input;
  const q = (s: string) => JSON.stringify(s); // YAML accepts JSON strings
  return [
    '# Rendered by the swarmy controller (apps/api/src/controller-store/litestream.ts).',
    '# Credentials are passed in the environment, never in this file.',
    'logging:',
    '  level: info',
    '  type: json',
    '  stderr: true',
    'socket:',
    '  enabled: true', // default permissions: 0600
    `  path: ${q(socketPath)}`,
    // Ship the tail on SIGTERM (clean moves have a zero loss window).
    'shutdown-sync-timeout: 20s',
    'dbs:',
    `  - path: ${q(dbPath)}`,
    // Litestream owns checkpointing while it runs (the controller sets
    // wal_autocheckpoint=0 on its connection). These are the v0.5 defaults, spelled out.
    '    checkpoint-interval: 1m',
    '    min-checkpoint-page-count: 1000',
    '    busy-timeout: 1s',
    '    replica:',
    '      type: s3',
    `      bucket: ${q(target.bucket)}`,
    `      path: ${q(litestreamPath(target))}`,
    `      endpoint: ${q(target.endpoint)}`,
    `      region: ${q(target.region)}`,
    '      force-path-style: true',
    '      sync-interval: 1s',
    ...(target.skipVerify ? ['      skip-verify: true'] : []),
    '',
  ].join('\n');
}

export function litestreamEnv(target: ReplicaTarget): Record<string, string> {
  return {
    LITESTREAM_ACCESS_KEY_ID: target.accessKeyId,
    LITESTREAM_SECRET_ACCESS_KEY: target.secretAccessKey,
  };
}

function childEnv(target: ReplicaTarget): Record<string, string> {
  // A minimal env: nothing of the controller's own secrets leaks into the child.
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const v = process.env[k];
    if (v) base[k] = v;
  }
  return { ...base, ...litestreamEnv(target) };
}

export function writeLitestreamConfig(p: StorePaths, target: ReplicaTarget): void {
  writeFileSync(p.litestreamConfig, renderLitestreamConfig({ dbPath: p.db, target, socketPath: p.litestreamSocket }), {
    mode: 0o600,
  });
}

/**
 * Restore the replica's latest state to a temp file, then swap it into place.
 * Returns false when the replica turned out to be empty.
 */
export async function restoreFromReplica(input: {
  bin: string;
  paths: StorePaths;
  target: ReplicaTarget;
  log: (m: string) => void;
}): Promise<boolean> {
  const { bin, paths, target, log } = input;
  writeLitestreamConfig(paths, target);
  const tmp = `${paths.db}.restoring`;
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  const proc = Bun.spawn(
    [bin, 'restore', '-config', paths.litestreamConfig, '-if-replica-exists', '-integrity-check', 'quick', '-o', tmp, paths.db],
    { env: childEnv(target), stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`litestream restore failed (exit ${code}): ${(err || out).trim().slice(-2000)}`);
  if (!existsSync(tmp)) {
    log('replica has no data; nothing restored');
    return false;
  }
  clearSidecarFiles(paths.db);
  rmSync(paths.db, { force: true });
  renameSync(tmp, paths.db);
  return true;
}

export interface LitestreamStatus {
  running: boolean;
  pid: number | null;
  /** Last successful upload to the replica (Litestream's own clock). */
  lastSyncAt: string | null;
  /** Local TXID Litestream has seen. */
  txid: string | null;
  /** WAL bytes written but not yet shipped (0 = caught up). */
  pendingWalBytes: number;
  error: string | null;
  restarts: number;
}

/**
 * The `replicate` child. `start()` keeps it running (restarting it with a
 * backoff) until `kill()` or `stop()`.
 */
export class LitestreamProcess {
  private proc: Subprocess | null = null;
  private wanted = false;
  private restarts = 0;
  private lastError: string | null = null;
  private tail: string[] = [];

  constructor(
    private readonly bin: string,
    private readonly paths: StorePaths,
    private readonly target: ReplicaTarget,
    private readonly log: (m: string) => void,
  ) {}

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    writeLitestreamConfig(this.paths, this.target);
    this.spawn();
  }

  private spawn(): void {
    const proc = Bun.spawn([this.bin, 'replicate', '-config', this.paths.litestreamConfig], {
      env: childEnv(this.target),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    this.proc = proc;
    void this.pump(proc);
    void proc.exited.then((code) => {
      if (this.proc === proc) this.proc = null;
      if (!this.wanted) return;
      this.restarts++;
      this.lastError = `litestream exited (${code}): ${this.tail.slice(-3).join(' | ')}`;
      this.log(this.lastError);
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.restarts, 5));
      setTimeout(() => this.wanted && !this.proc && this.spawn(), delay);
    });
  }

  private async pump(proc: Subprocess): Promise<void> {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === 'number') return;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of stderr as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        this.tail.push(line);
        if (this.tail.length > 50) this.tail.shift();
        // Surface warnings/errors in the controller log; info stays quiet.
        if (/"level":"(WARN|ERROR)"/i.test(line)) this.log(`litestream: ${line}`);
      }
    }
  }

  /** The fence: stop at once, NO final sync. */
  kill(): void {
    this.wanted = false;
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }

  /** Clean shutdown: SIGTERM lets Litestream ship what is left. */
  async stop(timeoutMs = 25_000): Promise<void> {
    this.wanted = false;
    const proc = this.proc;
    if (!proc) return;
    proc.kill('SIGTERM');
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
    if (!done) proc.kill('SIGKILL');
    this.proc = null;
  }

  async status(): Promise<LitestreamStatus> {
    const base: LitestreamStatus = {
      running: !!this.proc,
      pid: this.proc?.pid ?? null,
      lastSyncAt: null,
      txid: null,
      pendingWalBytes: 0,
      error: this.lastError,
      restarts: this.restarts,
    };
    if (!this.proc) return base;
    try {
      const sock = this.paths.litestreamSocket;
      const list = (await (await fetch('http://litestream/list', { unix: sock } as RequestInit)).json()) as {
        databases?: Array<{ path: string; last_sync_at?: string }>;
      };
      const mine = list.databases?.find((d) => d.path === this.paths.db) ?? list.databases?.[0];
      base.lastSyncAt = mine?.last_sync_at ?? null;
      const diag = (await (
        await fetch(`http://litestream/debug/sync-status?path=${encodeURIComponent(this.paths.db)}`, { unix: sock } as RequestInit)
      ).json()) as { databases?: Array<{ txid?: number; wal_size?: number; last_synced_wal_offset?: number; error?: string }> };
      const d = diag.databases?.[0];
      if (d) {
        base.txid = d.txid != null ? d.txid.toString(16).padStart(16, '0') : null;
        base.pendingWalBytes = Math.max(0, (d.wal_size ?? 0) - (d.last_synced_wal_offset ?? 0));
        if (d.error) base.error = d.error;
      }
    } catch (e) {
      base.error = base.error ?? `status unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    return base;
  }
}
