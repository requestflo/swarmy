/**
 * Each local volume's size, measured on a slow cadence and cached (boards 9
 * + 36). Docker's `/system/df?type=volume` walks every volume, so it runs at
 * most once per `VOLUME_SIZES_INTERVAL_MS`, never twice at once, and never
 * blocks the metrics tick: `take()` starts a measurement in the background
 * and hands the result out on a LATER tick. The sample rides the `metrics`
 * frame once per measurement, and again after every register (`resend()`,
 * so a restarted controller hears it without waiting ten minutes).
 */
import { parseVolumeDf } from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import { VOLUME_SIZES_INTERVAL_MS, type VolumeSizeEntry, type VolumeSizesSample } from '@swarmy/core/protocol';

export interface VolumeSizer {
  /** The sample to attach to this metrics frame (once per measurement / resend), else undefined. */
  take(): VolumeSizesSample | undefined;
  /** Send the cached sample again on the next frame (a new session). */
  resend(): void;
}

export interface VolumeSizerOptions {
  intervalMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createVolumeSizer(measure: () => Promise<VolumeSizeEntry[]>, opts: VolumeSizerOptions = {}): VolumeSizer {
  const intervalMs = opts.intervalMs ?? VOLUME_SIZES_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  let latest: VolumeSizesSample | undefined;
  let pending = false;
  let inFlight = false;
  let startedAt: number | undefined;
  let warned = false;

  const refresh = (): void => {
    inFlight = true;
    startedAt = now();
    measure()
      .then((volumes) => {
        latest = { sampledAt: now(), volumes };
        pending = true;
        warned = false;
      })
      .catch((e: unknown) => {
        // Unknown stays unknown: keep the last good sample, try again next interval.
        if (!warned) opts.log?.(`could not measure volume sizes: ${e instanceof Error ? e.message : String(e)}`);
        warned = true;
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    take() {
      if (!inFlight && (startedAt === undefined || now() - startedAt >= intervalMs)) refresh();
      if (!pending || !latest) return undefined;
      pending = false;
      return latest;
    },
    resend() {
      if (latest) pending = true;
    },
  };
}

/** The real measurement: Docker's df for volumes, parsed. */
export function dockerVolumeSizes(docker: DockerClient): () => Promise<VolumeSizeEntry[]> {
  return async () => parseVolumeDf(await docker.volumeDiskUsage());
}
