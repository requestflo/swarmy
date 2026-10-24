/**
 * `dbPitrWindow`: read a managed Postgres cluster's point-in-time recovery
 * window from its WAL repo, before a PITR restore changes anything.
 *
 * Read-only. The agent runs `wal-g backup-list --json --detail` in a sidecar
 * exactly as the restore does (same image, credentials as container env, same
 * networks), plus a best-effort listing of the archived WAL, and answers with
 * the base backups and the window. It touches no volume and no server.
 *
 * Gated by the `dbPitrWindow` agent capability (`capabilities.ts`): an older
 * agent would drop the frame, so the controller only sends it to an agent
 * that advertised it.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { ResticRepo } from './backup';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const DbPitrWindowPayload = z.object({
  ...cmd,
  /** wal-g only for now (pgbackrest would read `pgbackrest info --output=json`). */
  engine: z.literal('wal-g'),
  /** The destination the cluster's base backups and WAL go to (the restore's own repo). */
  repo: ResticRepo,
  /** The cluster net the restore's backup-list joins (parity with `dbRestore`). */
  network: z.string().optional(),
  /** The storage overlay, so an in-cluster destination (`swarmy-garage`) resolves. */
  resticNetwork: z.string().optional(),
  /** wal-g image override; defaults to `DEFAULT_WALG_IMAGE`. */
  engineImage: z.string().optional(),
});
export type DbPitrWindowPayload = z.infer<typeof DbPitrWindowPayload>;

export const DbPitrWindowMsg = z.object({
  type: z.literal('dbPitrWindow'),
  payload: DbPitrWindowPayload,
});
export type DbPitrWindowMsg = z.infer<typeof DbPitrWindowMsg>;

/** One base backup: a restore starts from the newest one that finished at or before the target. */
export const PitrBaseBackup = z.object({
  name: z.string(),
  startTime: z.string().optional(),
  /** ISO-8601 UTC. Recovery cannot stop before a backup's end. */
  finishTime: z.string(),
});
export type PitrBaseBackup = z.infer<typeof PitrBaseBackup>;

/** A recoverable span, ISO-8601 UTC at both ends. */
export const PitrWindow = z.object({ from: z.string(), to: z.string() });
export type PitrWindow = z.infer<typeof PitrWindow>;

export const DbPitrWindowResult = z.object({
  /** Base backups with a finish time, oldest first. */
  backups: z.array(PitrBaseBackup).default([]),
  /**
   * From when the oldest base backup finished to the newest archived change
   * (`latestWalAt`, or the check time when the WAL could not be listed).
   * Null when there are no base backups, so nothing is recoverable.
   */
  window: PitrWindow.nullable(),
  /** Upload time of the newest archived WAL segment, when the listing could be read. */
  latestWalAt: z.string().optional(),
  /** When the agent read the repo (its clock, ISO-8601 UTC). */
  checkedAt: z.string(),
});
export type DbPitrWindowResult = z.infer<typeof DbPitrWindowResult>;
