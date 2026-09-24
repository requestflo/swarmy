/**
 * Restore-on-boot. The controller image's entrypoint runs this BEFORE the
 * controller process opens control.db:
 *
 *   bun run apps/api/src/controller-store/boot.ts
 *
 * It decides where this task's control.db comes from (restore-select.ts):
 * keep the local file, restore from the Litestream replica, restore the latest
 * controller bundle, or start fresh. Then it carries that out. It writes a boot
 * report next to the DB. The supervisor reads the report for its
 * pre-replication check, and the dashboard shows it.
 *
 * Exit codes: 0 = ready to start. 75 = replica unreachable with no local file
 * (Swarm restarts us after its delay; we never start empty while a replica may
 * hold the data). 1 = refused, or a restore failed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  controllerIdentity,
  litestreamBin,
  loadControlStoreConfig,
  storePaths,
  type BundleSource,
  type StorePaths,
} from './config';
import { restoreFromReplica } from './litestream';
import {
  clearSidecarFiles,
  localDbExists,
  moveAsideLocal,
  readLocalMarker,
  readReplicaState,
  writeLocalMarker,
  type ReplicaState,
} from './replica';
import { selectBootSource, type BootDecision, type BootFacts, type WriterMarker } from './restore-select';

/** What boot saw and did, for the supervisor's pre-replication check. */
export interface BootReport {
  at: string;
  decision: BootDecision;
  /** Outcome of the decision ("restored from replica", "kept local", …). */
  outcome: string;
  /** Replica lineage the local file now descends from (null = unmarked/none). */
  expectMarker: WriterMarker | null;
  /** Replica head TXID (hex) at boot; null when the replica wasn't read. */
  bootHeadTxid: string | null;
  replicaConfigured: boolean;
  replicaError?: string;
  movedAside?: string | null;
  durationMs: number;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

export function readBootReport(p: StorePaths): BootReport | null {
  try {
    return JSON.parse(readFileSync(p.bootReport, 'utf8')) as BootReport;
  } catch {
    return null;
  }
}

async function readReplicaWithRetry(
  target: NonNullable<ReturnType<typeof loadControlStoreConfig>['replica']>,
  attempts: number,
  log: (m: string) => void,
): Promise<ReplicaState> {
  let last: ReplicaState | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await readReplicaState(target);
    if (last.reachable) return last;
    log(`replica unreachable (${last.error}); retry ${i + 1}/${attempts}`);
    await Bun.sleep(2_000);
  }
  return last!;
}

async function restoreBundleInto(p: StorePaths, bundle: BundleSource, log: (m: string) => void): Promise<string> {
  // Loaded lazily: the tRPC package is heavy and only this path needs it.
  const { restoreBundle } = await import('@swarmy/trpc');
  const contents = await restoreBundle({ repo: bundle.repo, snapshotId: 'latest', passphrase: bundle.passphrase });
  const bytes = contents.dbSnapshot;
  if (Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_MAGIC) {
    throw new Error('the bundle snapshot is not a SQLite database');
  }
  if (contents.secrets.SWARMY_SECRET_KEY && process.env.SWARMY_SECRET_KEY && contents.secrets.SWARMY_SECRET_KEY !== process.env.SWARMY_SECRET_KEY) {
    // Never hot-swap the vault key: surface it. Encrypted columns won't decrypt
    // until the service's swarmy_secret_key secret matches the bundle.
    log('WARNING: the bundle was taken with a different SWARMY_SECRET_KEY than this controller runs with');
  }
  clearSidecarFiles(p.db);
  const tmp = `${p.db}.restore-tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, p.db);
  return `restored controller bundle taken ${contents.manifest.createdAt}`;
}

export async function runBoot(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): Promise<number> {
  const started = Date.now();
  const paths = storePaths(env);
  const cfg = loadControlStoreConfig(env);
  const id = controllerIdentity(env);
  mkdirSync(paths.dir, { recursive: true });

  const local = { exists: localDbExists(paths), marker: readLocalMarker(paths) };
  const replica = cfg.replica ? await readReplicaWithRetry(cfg.replica, local.exists ? 2 : 10, log) : null;
  const forced = env.SWARMY_BOOT_SOURCE as BootFacts['forced'] | undefined;
  const facts: BootFacts = {
    local,
    replica: {
      configured: !!cfg.replica,
      reachable: replica?.reachable ?? false,
      hasData: replica?.hasData ?? false,
      marker: replica?.marker ?? null,
    },
    bundle: { configured: !!cfg.bundle },
    priorController: !!(env.SWARMY_LEASE_AT_START?.trim() || local.marker || replica?.marker),
    allowFresh: env.SWARMY_ALLOW_FRESH === '1',
    ...(forced && ['local', 'replica', 'bundle', 'fresh'].includes(forced) ? { forced } : {}),
  };
  const decision = selectBootSource(facts);
  log(`boot: ${decision.kind} (${decision.reason}) [task ${id.taskId} on ${id.hostname}]`);

  let outcome = '';
  let expectMarker: WriterMarker | null = null;
  let movedAside: string | null = null;
  let headTxid = replica?.reachable ? replica.headTxid : null;

  switch (decision.kind) {
    case 'refuse':
      log(`boot: REFUSING TO START. ${decision.reason}`);
      return 1;
    case 'wait':
      log(`boot: ${decision.reason}. Exiting so Swarm retries.`);
      return 75;
    case 'keep-local':
      outcome = 'kept the local file';
      expectMarker = local.marker;
      // The local lineage is only "the replica's" if the markers matched; when
      // the replica was unreachable, the pre-replication check re-reads it.
      if (!replica?.reachable) headTxid = null;
      break;
    case 'fresh':
      if (decision.moveAsideLocal) movedAside = moveAsideLocal(paths);
      outcome = 'starting with an empty store';
      expectMarker = replica?.marker ?? null;
      break;
    case 'restore-replica': {
      if (!cfg.replica) throw new Error('restore-replica without a replica target');
      if (decision.moveAsideLocal) movedAside = moveAsideLocal(paths);
      const t0 = Date.now();
      const restored = await restoreFromReplica({ bin: litestreamBin(env), paths, target: cfg.replica, log });
      if (!restored) {
        outcome = 'replica turned out empty; starting with an empty store';
      } else {
        outcome = `restored from the replica (${cfg.replica.label}) in ${Date.now() - t0} ms`;
      }
      // Re-read: the head we restored up to is at least what we list now.
      const after = await readReplicaState(cfg.replica);
      expectMarker = after.marker ?? replica?.marker ?? null;
      headTxid = after.reachable ? after.headTxid : (replica?.headTxid ?? null);
      if (expectMarker) writeLocalMarker(paths, expectMarker);
      break;
    }
    case 'restore-bundle': {
      if (!cfg.bundle) throw new Error('restore-bundle without a bundle source');
      if (decision.moveAsideLocal) movedAside = moveAsideLocal(paths);
      outcome = await restoreBundleInto(paths, cfg.bundle, log);
      // A bundle starts a new lineage. If a replica exists but is empty, we become its first writer.
      expectMarker = replica?.marker ?? null;
      break;
    }
  }

  const report: BootReport = {
    at: new Date().toISOString(),
    decision,
    outcome,
    expectMarker,
    bootHeadTxid: headTxid != null ? headTxid.toString(16).padStart(16, '0') : null,
    replicaConfigured: !!cfg.replica,
    ...(replica?.error ? { replicaError: replica.error } : {}),
    movedAside,
    durationMs: Date.now() - started,
  };
  writeFileSync(paths.bootReport, JSON.stringify(report, null, 2), { mode: 0o600 });
  log(`boot: ${outcome}${movedAside ? ` (stale file kept as ${movedAside})` : ''}`);
  return 0;
}

if (import.meta.main) {
  runBoot()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`boot: failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
