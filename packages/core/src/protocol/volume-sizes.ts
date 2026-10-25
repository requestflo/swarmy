/**
 * How big each local volume on a server is (boards 9 "disk fit" and 36
 * "Placement & volumes"). The agent measures with Docker's
 * `GET /system/df?type=volume` (`UsageData.Size`) on a slow cadence — it
 * walks every volume, which is expensive on a big host — caches the answer
 * and sends it ADDITIVELY on a `metrics` frame (`MetricsPayload.volumes`):
 * once after each measurement and again after every register, never on
 * every tick. Older agents send nothing; older controllers drop the field.
 * The controller keeps the latest per node in memory only (no history).
 */
import { z } from 'zod';
import { Timestamp } from './primitives';

/** How often the agent measures volume sizes. */
export const VOLUME_SIZES_INTERVAL_MS = 10 * 60_000;
/** At most this many volumes per report (the largest kept). */
export const MAX_REPORTED_VOLUMES = 2_000;

export const VolumeSizeEntry = z.object({
  /** Docker volume name. */
  name: z.string().min(1).max(255),
  /** Bytes on disk (`UsageData.Size`). */
  sizeBytes: z.number().int().nonnegative(),
  /** Containers referencing it (`UsageData.RefCount`), when Docker says. */
  refCount: z.number().int().nonnegative().optional(),
});
export type VolumeSizeEntry = z.infer<typeof VolumeSizeEntry>;

export const VolumeSizesSample = z.object({
  /** When the agent measured (its clock). */
  sampledAt: Timestamp,
  /** Every local volume Docker could size; a volume it can't size is left out. */
  volumes: z.array(VolumeSizeEntry).max(MAX_REPORTED_VOLUMES),
});
export type VolumeSizesSample = z.infer<typeof VolumeSizesSample>;
