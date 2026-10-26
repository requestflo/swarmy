import { splitImageRef } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * Has a rollback settled? (pure — the watcher polls the live swarm.)
 *
 * Judged only from Docker truth, per part the rollback's release deployed:
 * the live service runs the put-back image, Docker's rolling update isn't
 * still going, and every copy it wants is running. Docker pausing or undoing
 * the update means it won't settle on its own.
 */

export type SettleLive = Pick<SwarmServiceInfo, 'name' | 'image' | 'desiredReplicas' | 'runningReplicas' | 'updateStatus'>;
export type SettleState = 'rolling' | 'healthy' | 'failed';

const tagOf = (image: string): string => splitImageRef(image.split('@')[0] ?? image).reference;

/** Does the live image (often `ref:tag@sha256:…`) run the deployed `spec` ref? */
export function sameImage(spec: string, live: string): boolean {
  const a = splitImageRef(spec);
  const b = splitImageRef(live);
  if (a.host !== b.host || a.repo !== b.repo) return false;
  const at = spec.indexOf('@');
  return at >= 0 ? live.includes(spec.slice(at + 1)) : tagOf(spec) === tagOf(live);
}

export function rollbackSettle(live: readonly SettleLive[], images: ReadonlyArray<{ name: string; image: string }>): SettleState {
  let rolling = false;
  for (const want of images) {
    const svc = live.find((s) => s.name === want.name);
    if (!svc) {
      rolling = true;
      continue;
    }
    if (svc.updateStatus === 'paused' || svc.updateStatus === 'rollback_started' || svc.updateStatus === 'rollback_completed') return 'failed';
    const copies = svc.desiredReplicas === undefined ? svc.runningReplicas > 0 : svc.runningReplicas >= svc.desiredReplicas;
    if (svc.updateStatus === 'updating' || !sameImage(want.image, svc.image) || !copies) rolling = true;
  }
  return rolling ? 'rolling' : 'healthy';
}
