import { z } from 'zod';
import { CommandId } from './primitives';
import { ErrorPayload } from './errors';
import type { IngressDriverName } from './ingress';

export const CommandStatus = z.enum([
  'accepted',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'rejected',
  'canceled',
]);
export type CommandStatus = z.infer<typeof CommandStatus>;

export const CommandResultPayload = z.object({
  /** Correlates back to the controller command's `payload.commandId`. */
  commandId: CommandId,
  status: CommandStatus,
  startedAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
  /** Command-specific success payload (see `CommandResultMap`). */
  result: z.unknown().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), detail: z.unknown().optional() })
    .optional(),
});
export type CommandResultPayload = z.infer<typeof CommandResultPayload>;

export const CommandResultMsg = z.object({
  type: z.literal('commandResult'),
  payload: CommandResultPayload,
});
export type CommandResultMsg = z.infer<typeof CommandResultMsg>;

/** Typed `result` shapes per originating command, for controller-side narrowing. */
import type { ResticSnapshotInfo } from './backup';
import type { ApplyMeshResult } from './mesh';
import type { BuildImageResult } from './build';
import type { SwarmJoinResult } from './swarm';

export interface CommandResultMap {
  deployService: { serviceId: string; created: boolean };
  removeService: { serviceId: string };
  scaleService: { serviceId: string };
  restartService: { serviceId: string };
  pullImage: { image: string; digest: string };
  applyIngress: { driver: IngressDriverName; reloaded: boolean };
  execCommand: { exitCode: number };
  updateSwarmNode: { swarmNodeId: string };
  backupVolume: { snapshotId: string; sizeBytes: number; filesNew?: number; durationMs?: number };
  restoreVolume: { targetVolume: string; bytesRestored: number; durationMs?: number };
  listSnapshots: { snapshots: ResticSnapshotInfo[] };
  applyMesh: ApplyMeshResult;
  buildImage: BuildImageResult;
  swarmJoin: SwarmJoinResult;
}

export const LogChunkPayload = z.object({
  commandId: CommandId,
  stream: z.enum(['stdout', 'stderr']),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  eof: z.boolean().default(false),
});
export type LogChunkPayload = z.infer<typeof LogChunkPayload>;

export const LogChunkMsg = z.object({
  type: z.literal('logChunk'),
  payload: LogChunkPayload,
});
export type LogChunkMsg = z.infer<typeof LogChunkMsg>;

/** Lightweight receipt used in both directions. */
export const AckPayload = z.object({
  refId: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type AckPayload = z.infer<typeof AckPayload>;

export const AckMsg = z.object({ type: z.literal('ack'), payload: AckPayload });
export type AckMsg = z.infer<typeof AckMsg>;

/** Both directions use the same `error` message shape. */
export const AgentErrorMsg = z.object({ type: z.literal('error'), payload: ErrorPayload });
export type AgentErrorMsg = z.infer<typeof AgentErrorMsg>;

export const ControllerErrorMsg = z.object({ type: z.literal('error'), payload: ErrorPayload });
export type ControllerErrorMsg = z.infer<typeof ControllerErrorMsg>;
