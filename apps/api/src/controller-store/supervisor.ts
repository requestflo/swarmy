/**
 * The controller store at runtime: take the raft lease, check the replica,
 * run Litestream, renew, and fence.
 *
 *   acquiring ──lease──▶ leader ──renew fails past deadline / lost──▶ fenced (exit 70)
 *                          │
 *                          └─ SIGTERM ─▶ stop writes → Litestream final sync → release → exit 0
 *
 * Workers (the reconcilers that write to Docker and the DB) start only once
 * we hold the lease, so two controllers never reconcile at once. Litestream
 * starts only after the lease AND the pre-replication check pass, so two
 * controllers never ship to one replica.
 *
 * Outside Swarm (dev: no SWARMY_TASK_ID) there is nobody to fence against, and
 * the store runs "standalone": workers start at once and nothing replicates
 * unless a replica is configured.
 */
import type { ControllerLeaseRecord, ControllerServiceOp, ControllerServiceResult } from '@swarmy/core/protocol';
import { controllerIdentity, litestreamBin, loadControlStoreConfig, storePaths, type ControlStoreConfig, type ControllerIdentity, type StorePaths } from './config';
import { readBootReport, type BootReport } from './boot';
import {
  LEASE_FENCE_MARGIN_MS,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  minEpoch,
  mustFence,
  observe,
  stillHeld,
  takeoverDecision,
  type LeaseObservation,
} from './lease';
import { LitestreamProcess, type LitestreamStatus } from './litestream';
import { readLocalMarker, readReplicaState, writeLocalMarker, writeReplicaMarker } from './replica';
import { replicationPrecheck, type WriterMarker } from './restore-select';

export interface StoreDeps {
  /** Online manager node ids, the preferred one (our own node) first. */
  managers(): string[];
  dispatch(nodeId: string, payload: { service: string; op: ControllerServiceOp }, timeoutMs: number): Promise<ControllerServiceResult>;
  /** Run a PRAGMA on the app's one SQLite connection. */
  pragma(sql: string): Promise<void>;
  /** Called once when we become the writer (start the workers). Returns a stop fn. */
  onLeader(): () => void;
  log(msg: string): void;
  exit(code: number): never;
  env?: NodeJS.ProcessEnv;
}

export type StoreRole = 'standalone' | 'acquiring' | 'leader' | 'fenced' | 'stopping';

export interface ControllerStoreStatus {
  role: StoreRole;
  identity: ControllerIdentity;
  lease: ControllerLeaseRecord | null;
  epoch: number | null;
  /** Local ms since the last good renewal was sent. */
  leaseAgeMs: number | null;
  waitingFor: string | null;
  replica: null | {
    kind: 'garage' | 'backup-target';
    label: string;
    targetId?: string;
    endpoint: string;
    bucket: string;
    prefix: string;
  };
  replicating: boolean;
  /** Why replication hasn't started yet, when it should have. */
  replicationBlocked: string | null;
  litestream: LitestreamStatus | null;
  bundleConfigured: boolean;
  boot: BootReport | null;
  dbPath: string;
}

export class ControllerStore {
  private role: StoreRole = 'acquiring';
  private epoch: number | null = null;
  private lease: ControllerLeaseRecord | null = null;
  private obs: LeaseObservation | null = null;
  private lastOkSentAt = 0;
  private waitingFor: string | null = null;
  private replicationBlocked: string | null = null;
  private litestream: LitestreamProcess | null = null;
  private stopWorkers: (() => void) | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private consecutiveTimeouts = 0;
  private readonly id: ControllerIdentity;
  private readonly paths: StorePaths;
  private readonly cfg: ControlStoreConfig;
  private readonly boot: BootReport | null;
  private readonly leaseEnabled: boolean;

  constructor(private readonly deps: StoreDeps) {
    const env = deps.env ?? process.env;
    this.id = controllerIdentity(env);
    this.paths = storePaths(env);
    this.cfg = loadControlStoreConfig(env);
    this.boot = readBootReport(this.paths);
    this.leaseEnabled = env.SWARMY_CONTROLLER_LEASE !== 'off' && !!env.SWARMY_TASK_ID;
  }

  start(): void {
    if (!this.leaseEnabled) {
      this.role = 'standalone';
      this.deps.log('controller store: standalone (no Swarm task identity); workers start now');
      this.becomeWriter();
      return;
    }
    this.deps.log(`controller store: acquiring the lease as task ${this.id.taskId} on ${this.id.hostname}`);
    void this.acquireTick();
    this.timers.push(setInterval(() => void this.acquireTick(), 3_000));
  }

  // ── acquiring ────────────────────────────────────────────────────────────

  private acquiring = false;
  private async acquireTick(): Promise<void> {
    if (this.role !== 'acquiring' || this.acquiring) return;
    this.acquiring = true;
    try {
      const node = this.deps.managers()[0];
      if (!node) {
        this.waitingFor = 'a manager agent to connect';
        return;
      }
      const floor = minEpoch(readLocalMarker(this.paths)?.epoch, this.boot?.expectMarker?.epoch);
      // Probe first (acquires only a free/released lease), then decide on what we saw.
      let expect: ControllerLeaseRecord | null | undefined = undefined;
      if (this.obs) {
        const d = takeoverDecision(this.obs, { holder: this.id.taskId, node: this.id.nodeId }, performance.now());
        if (d.take) expect = d.expect;
        else this.waitingFor = `lease held by ${d.holder.hostname ?? d.holder.node} (epoch ${d.holder.epoch}); taking over in ${Math.ceil(d.waitMs / 1000)}s unless renewed`;
      }
      const sentAt = performance.now();
      const res = await this.call(node, {
        kind: 'lease.acquire',
        holder: this.id.taskId,
        node: this.id.nodeId,
        hostname: this.id.hostname,
        ttlMs: LEASE_TTL_MS,
        expect: expect ?? null,
        minEpoch: floor,
      });
      if (!res) return;
      if (res.ok && res.lease && res.lease.holder === this.id.taskId) {
        this.lastOkSentAt = sentAt;
        this.lease = res.lease;
        this.epoch = res.lease.epoch;
        await this.onAcquired(node);
        return;
      }
      this.obs = observe(this.obs, res.lease, performance.now());
    } finally {
      this.acquiring = false;
    }
  }

  private async onAcquired(node: string): Promise<void> {
    this.role = 'leader';
    this.waitingFor = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.deps.log(`controller store: lease acquired (epoch ${this.epoch})`);
    this.timers.push(setInterval(() => void this.renewTick(), LEASE_RENEW_EVERY_MS));
    this.timers.push(setInterval(() => this.watchdog(), 1_000));
    // A move labelled the other managers "avoid"; we're here now, so undo it.
    void this.call(node, { kind: 'move.clear' });
    this.becomeWriter();
    await this.startReplication();
  }

  private becomeWriter(): void {
    if (this.stopWorkers) return;
    this.stopWorkers = this.deps.onLeader();
    if (this.role === 'standalone' && this.cfg.replica) void this.startReplication();
  }

  // ── replication ──────────────────────────────────────────────────────────

  private async startReplication(): Promise<void> {
    const target = this.cfg.replica;
    if (!target || this.litestream) return;
    const now = await readReplicaState(target);
    if (!now.reachable) {
      this.replicationBlocked = `replica unreachable: ${now.error ?? 'unknown error'}; retrying`;
      setTimeout(() => this.isWriter() && void this.startReplication(), 15_000);
      return;
    }
    const local = readLocalMarker(this.paths);
    const expected = this.boot?.expectMarker ?? local;
    const check = replicationPrecheck({
      bootMarker: expected,
      bootHeadTxid: this.boot?.bootHeadTxid != null ? BigInt(`0x${this.boot.bootHeadTxid}`) : now.headTxid,
      nowMarker: now.marker,
      nowHeadTxid: now.headTxid,
    });
    if (!check.ok) {
      // Another controller shipped after our boot restore. Restarting re-runs
      // boot, which sees the marker mismatch and restores the newer state.
      this.deps.log(`controller store: ${check.reason}. Releasing the lease and restarting to re-restore.`);
      await this.shutdown(75);
      return;
    }
    const marker: WriterMarker = {
      holder: this.id.taskId,
      epoch: this.epoch ?? 0,
      node: this.id.nodeId,
      hostname: this.id.hostname,
      at: Date.now(),
    };
    // Local first: a crash between the two writes then reads as "stale local" (safe).
    writeLocalMarker(this.paths, marker);
    await writeReplicaMarker(target, marker);
    // Litestream owns checkpoints while it runs.
    await this.deps.pragma('PRAGMA wal_autocheckpoint=0').catch((e) => this.deps.log(`pragma failed: ${String(e)}`));
    this.litestream = new LitestreamProcess(litestreamBin(this.deps.env), this.paths, target, this.deps.log);
    this.litestream.start();
    this.replicationBlocked = null;
    this.deps.log(`controller store: replicating ${this.paths.db} to ${target.label} (${target.bucket}/${target.prefix})`);
  }

  private isWriter(): boolean {
    return this.role === 'leader' || this.role === 'standalone';
  }

  // ── leader ───────────────────────────────────────────────────────────────

  private renewing = false;
  private async renewTick(): Promise<void> {
    if (this.role !== 'leader' || this.renewing || this.epoch == null) return;
    this.renewing = true;
    try {
      for (const node of this.deps.managers().slice(0, 2)) {
        const sentAt = performance.now();
        const res = await this.call(node, {
          kind: 'lease.renew',
          holder: this.id.taskId,
          node: this.id.nodeId,
          hostname: this.id.hostname,
          ttlMs: LEASE_TTL_MS,
          epoch: this.epoch,
        });
        if (!res) continue; // unreachable: try the next manager, the watchdog keeps time
        if (stillHeld(res, { holder: this.id.taskId, node: this.id.nodeId }, this.epoch)) {
          this.lastOkSentAt = sentAt;
          this.lease = res.lease;
          return;
        }
        if (res.reason === 'lost' || (res.ok && !stillHeld(res, { holder: this.id.taskId, node: this.id.nodeId }, this.epoch))) {
          this.fence(`lease lost to ${res.lease ? `epoch ${res.lease.epoch} on ${res.lease.hostname ?? res.lease.node}` : 'nobody (label removed)'}`);
          return;
        }
        // 'conflict' (a CAS race): next tick retries against the fresh version.
      }
    } finally {
      this.renewing = false;
    }
  }

  private watchdog(): void {
    if (this.role !== 'leader') return;
    if (mustFence(performance.now(), this.lastOkSentAt, LEASE_TTL_MS, LEASE_FENCE_MARGIN_MS)) {
      this.fence(`no successful renewal for ${Math.round((performance.now() - this.lastOkSentAt) / 1000)}s`);
    }
  }

  /** We may no longer be the writer: stop writing, kill Litestream WITHOUT a final sync, exit. */
  private fence(why: string): never {
    this.role = 'fenced';
    this.deps.log(`controller store: FENCED: ${why}. Stopping writes and exiting.`);
    this.litestream?.kill();
    void this.deps.pragma('PRAGMA query_only=1').catch(() => undefined);
    return this.deps.exit(70);
  }

  // ── clean shutdown ───────────────────────────────────────────────────────

  async shutdown(code = 0): Promise<never> {
    if (this.role === 'stopping' || this.role === 'fenced') return this.deps.exit(code);
    const wasLeader = this.role === 'leader';
    this.role = 'stopping';
    for (const t of this.timers) clearInterval(t);
    try {
      this.stopWorkers?.();
    } catch {
      // workers stop best-effort
    }
    // Stop writes first, so the final sync is truly final.
    await this.deps.pragma('PRAGMA query_only=1').catch(() => undefined);
    if (this.litestream) {
      this.deps.log('controller store: shipping the last writes to the replica…');
      await this.litestream.stop();
    }
    if (wasLeader && this.epoch != null) {
      const node = this.deps.managers()[0];
      if (node) await this.call(node, { kind: 'lease.release', holder: this.id.taskId, epoch: this.epoch }, 5_000);
      this.deps.log(`controller store: lease released (epoch ${this.epoch})`);
    }
    return this.deps.exit(code);
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private async call(node: string, op: ControllerServiceOp, timeoutMs = 8_000): Promise<ControllerServiceResult | null> {
    try {
      const res = await this.deps.dispatch(node, { service: this.id.service, op }, timeoutMs);
      this.consecutiveTimeouts = 0;
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout/i.test(msg)) this.consecutiveTimeouts++;
      if (this.role === 'acquiring') {
        this.waitingFor = `lease call failed: ${msg}`;
        // Agents older than P3 drop the unknown command. Pinned (not replicated)
        // there is no second controller to fence against, so run rather than stall.
        if (this.consecutiveTimeouts >= 4 && !this.cfg.replica) {
          this.deps.log('controller store: manager agents do not answer the lease command (older agents?); running without the lease');
          this.role = 'standalone';
          for (const t of this.timers) clearInterval(t);
          this.timers = [];
          this.becomeWriter();
        }
      }
      return null;
    }
  }

  async status(): Promise<ControllerStoreStatus> {
    const t = this.cfg.replica;
    return {
      role: this.role,
      identity: this.id,
      lease: this.lease,
      epoch: this.epoch,
      leaseAgeMs: this.lastOkSentAt ? Math.round(performance.now() - this.lastOkSentAt) : null,
      waitingFor: this.waitingFor,
      replica: t
        ? { kind: t.kind, label: t.label, ...(t.targetId ? { targetId: t.targetId } : {}), endpoint: t.endpoint, bucket: t.bucket, prefix: t.prefix }
        : null,
      replicating: !!this.litestream,
      replicationBlocked: this.replicationBlocked,
      litestream: this.litestream ? await this.litestream.status() : null,
      bundleConfigured: !!this.cfg.bundle,
      boot: this.boot,
      dbPath: this.paths.db,
    };
  }
}
