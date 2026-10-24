/**
 * Samples the two TXIDs lag.ts turns into a replication lag, for as long as
 * Litestream runs: the local position every second over Litestream's control
 * socket, and the replica head every few seconds from the bucket listing.
 *
 * Every read is time-boxed. Litestream v0.5 can hold a control-socket request
 * open for as long as its replica is unreachable (seen with `/list` against a
 * dead endpoint), and a status read must never hang the dashboard.
 */
import type { ReplicaTarget } from './config';
import { emptyLag, noteLocal, noteReplica, noteReplicaError, readLag, type LagReading, type LagState } from './lag';
import { readReplicaHead } from './replica';

export const LOCAL_EVERY_MS = 1_000;
/** Read the replica every N local samples (a LIST of a few hundred keys). */
export const REPLICA_EVERY = 5;
const SOCKET_TIMEOUT_MS = 2_000;
const LIST_TIMEOUT_MS = 8_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GET a JSON document from Litestream's control socket, bounded. */
export async function socketJson<T>(socket: string, path: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`http://litestream${path}`, { unix: socket, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  if (!res.ok) throw new Error(`litestream ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface LagSources {
  /** Litestream's local TXID (null = it didn't say). */
  local(): Promise<bigint | null>;
  /** The replica's head TXID. Throws when the bucket can't be read. */
  replicaHead(): Promise<bigint>;
}

export function litestreamSources(socket: string, dbPath: string, target: ReplicaTarget): LagSources {
  return {
    async local() {
      const r = await socketJson<{ txid?: number }>(socket, `/txid?path=${encodeURIComponent(dbPath)}`);
      return typeof r.txid === 'number' ? BigInt(r.txid) : null;
    },
    replicaHead: () => bounded(readReplicaHead(target), LIST_TIMEOUT_MS, 'replica listing'),
  };
}

export interface LagMonitorReading extends LagReading {
  /** Why Litestream's own position couldn't be read (null = it answered last time). */
  localError: string | null;
}

export class LagMonitor {
  private state: LagState = emptyLag();
  private localError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Local samples since the last replica read (starts due). */
  private sinceReplica = REPLICA_EVERY;
  private busy = false;

  constructor(
    private readonly src: LagSources,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), LOCAL_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sample. Public for tests; the timer calls it every LOCAL_EVERY_MS. */
  async sample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let local: bigint | null = null;
      try {
        local = await this.src.local();
        this.localError = local == null ? 'litestream reported no position' : null;
      } catch (e) {
        this.localError = message(e);
      }
      if (local == null) return; // the replica read must follow a fresh local one
      this.state = noteLocal(this.state, local, this.clock());
      if (++this.sinceReplica < REPLICA_EVERY) return;
      this.sinceReplica = 0;
      try {
        this.state = noteReplica(this.state, await this.src.replicaHead(), this.clock());
      } catch (e) {
        this.state = noteReplicaError(this.state, message(e));
      }
    } finally {
      this.busy = false;
    }
  }

  reading(): LagMonitorReading {
    return { ...readLag(this.state, this.clock()), localError: this.localError };
  }
}
