import { z } from 'zod';
import { CommandId, MessageId } from './primitives';
import { ResticRepo, SnapshotRef } from './backup';
import { imageFallbackFields } from './helper-pull';
import { STREAM_CHUNK_BYTES, STREAM_MAX_CHUNK_BYTES, STREAM_MAX_CREDIT } from './stream';
import { SNAPSHOT_DATA_ROOT, SNAPSHOT_PATH_RE } from '../snapshot-path';

/**
 * Reading INSIDE a volume backup (board 16: "Download a file or folder…").
 * `snapshotLs` is a read-only command (`restic ls`); `snapshotDump` starts a
 * credit-flow stream (`stream.ts`) of `restic dump`. Both are additive agent
 * capabilities: the controller sends them only to an agent that advertised
 * them (`AGENT_CAPABILITY.snapshotLs` / `.snapshotDump`). Their restic image
 * comes from the in-cluster mirror like every backup sidecar's
 * (`helper-pull.ts`: `fallbackImage` + `registryAuth`), only for an agent
 * that advertises `snapshotReadMirror`.
 */

export { SNAPSHOT_DATA_ROOT, SNAPSHOT_PATH_RE };
/** A path inside a volume snapshot: `/data` or under it, never `..` (see {@link SNAPSHOT_PATH_RE}). */
export const SnapshotPath = z.string().max(4096).regex(SNAPSHOT_PATH_RE, 'invalid snapshot path');

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

// ── snapshotLs (read-only command) ──────────────────────────────────────────

export const SnapshotLsPayload = z.object({
  ...cmd,
  repo: ResticRepo,
  snapshotId: SnapshotRef,
  path: SnapshotPath.default(SNAPSHOT_DATA_ROOT),
  /** Most children returned; past it the result says `truncated`. */
  limit: z.number().int().min(1).max(5000).default(500),
  image: z.string().optional(),
  ...imageFallbackFields,
  network: z.string().optional(),
});
export type SnapshotLsPayload = z.infer<typeof SnapshotLsPayload>;
export const SnapshotLsMsg = z.object({ type: z.literal('snapshotLs'), payload: SnapshotLsPayload });
export type SnapshotLsMsg = z.infer<typeof SnapshotLsMsg>;

export const SnapshotEntry = z.object({
  /** Absolute path in the snapshot (`/data/…`). */
  path: z.string(),
  name: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  /** Bytes, for files. */
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
});
export type SnapshotEntry = z.infer<typeof SnapshotEntry>;

export const SnapshotLsResult = z.object({
  /** The path itself, or null when the snapshot has nothing there. */
  node: SnapshotEntry.nullable(),
  /** A directory's direct children (empty for a file). */
  entries: z.array(SnapshotEntry).default([]),
  truncated: z.boolean().default(false),
});
export type SnapshotLsResult = z.infer<typeof SnapshotLsResult>;

// ── snapshotDump (starts a stream) ──────────────────────────────────────────

export const SnapshotDumpPayload = z.object({
  streamId: MessageId,
  repo: ResticRepo,
  snapshotId: SnapshotRef,
  path: SnapshotPath,
  /** `dir` → `restic dump --archive tar` (a tar stream); `file` → the file's own bytes. */
  kind: z.enum(['file', 'dir']),
  /** Chunks the agent may send before it waits for a `streamCredit`. */
  credit: z.number().int().min(1).max(STREAM_MAX_CREDIT),
  chunkBytes: z.number().int().min(4096).max(STREAM_MAX_CHUNK_BYTES).default(STREAM_CHUNK_BYTES),
  /** Stop with `E_TOO_LARGE` past this many bytes (the agent also applies its own ceiling). */
  maxBytes: z.number().int().positive(),
  image: z.string().optional(),
  ...imageFallbackFields,
  network: z.string().optional(),
});
export type SnapshotDumpPayload = z.infer<typeof SnapshotDumpPayload>;
export const SnapshotDumpMsg = z.object({ type: z.literal('snapshotDump'), payload: SnapshotDumpPayload });
export type SnapshotDumpMsg = z.infer<typeof SnapshotDumpMsg>;
