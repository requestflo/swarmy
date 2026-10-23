/**
 * Abandon for the system-services step of a paused platform upgrade
 * (plans/epic-platform-upgrades.md §2) — pure over its IO seam.
 *
 * Each service the run moved goes back to the EXACT image it ran before (the
 * system step records it as `data.from`), with the same health gate as the
 * forward roll (`docker service update --update-failure-action rollback`),
 * one at a time, newest first. Not `docker service rollback`: after a pause
 * the previous spec may be a later label change rather than the old image,
 * and a second `rollback` after a restart would flip the service forward
 * again. Idempotent: a service already on its old image is just ticked off,
 * and every service put back leaves `data.updated`, so a Resume re-rolls it.
 */
import { digestOf, updateLanded, type StepContext } from './platform-upgrade.plan';

export interface SystemAbandonIO {
  /** Live system services (hub inventory). */
  live: () => ReadonlyArray<{ name: string; image: string }>;
  /** Health-gated `docker service update --image` → the update marker. */
  update: (service: string, image: string) => Promise<{ rc: number; state: string }>;
}

/** Same image? By digest when both are pinned, else the exact ref. Pure. */
export function sameImage(a: string, b: string): boolean {
  const da = digestOf(a);
  const db = digestOf(b);
  return da && db ? da === db : a === b;
}

export async function systemAbandon(c: StepContext, io: SystemAbandonIO): Promise<string> {
  const d = (c.step.data ??= {}) as { updated?: string[]; from?: Record<string, string> };
  const moved = [...(d.updated ?? [])].reverse();
  if (!moved.length) return 'no system service was changed';
  const back: string[] = [];
  const stuck: string[] = [];
  for (const svc of moved) {
    const prev = d.from?.[svc];
    if (!prev) {
      stuck.push(`${svc} (its previous image was not recorded)`);
      continue;
    }
    const live = io.live().find((s) => s.name === svc);
    if (live && !sameImage(live.image, prev)) {
      c.step.detail = `${svc}: back to ${prev.split('@')[0]}`;
      await c.checkpoint();
      if (!updateLanded(await io.update(svc, prev))) {
        stuck.push(svc);
        continue;
      }
    }
    d.updated = (d.updated ?? []).filter((s) => s !== svc);
    back.push(svc);
    c.note(`${svc}: back on ${prev}`);
    await c.checkpoint();
  }
  if (stuck.length) throw new Error(`${stuck.join(', ')} could not go back healthy — Swarm kept the new image`);
  return `${back.join(', ')} back on the previous image${back.length === 1 ? '' : 's'}`;
}
