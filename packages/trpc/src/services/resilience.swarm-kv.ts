/**
 * Resilience check `swarm-kv-size`: is a cluster config document (or
 * swarmy's whole swarm-kv footprint in raft) nearing its size limit? At the
 * limit swarmy refuses the save, so a backup destination, an app's compose
 * file or the front door stops taking changes. PURE classifier over the
 * warnings `kvSizeWarnings` computes; the signal is a cache read of the org's
 * store (backups-dr invariant 9: never read ctx from a classifier).
 */
import { kvSizeWarnings, type KvSizeWarning, type ResilienceProblemView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { swarmKvFor } from './swarm-kv.service';

export interface SwarmKvSizeSignal {
  warnings: KvSizeWarning[];
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const pct = (r: number): string => `${Math.round(r * 100)}%`;
const FIX = { fixPath: '/settings/platform', fixLabel: 'See cluster config' } as const;

export function swarmKvSizeProblems(sig: SwarmKvSizeSignal | undefined): ResilienceProblemView[] {
  return (sig?.warnings ?? []).map((w): ResilienceProblemView => {
    const full = w.severity === 'crit';
    if (w.scope === 'total') {
      return {
        id: 'swarm-kv-size/total',
        check: 'swarm-kv-size',
        severity: full ? 'crit' : 'warn',
        title: full ? "swarmy's config in the swarm is at its budget" : "swarmy's config in the swarm is nearing its budget",
        detail: `Every setting swarmy keeps in the swarm, with its kept versions, takes ${kb(w.bytes)} of ${kb(w.limit)} (${pct(w.ratio)}). Past the budget swarmy refuses new saves, to keep the managers' snapshots small.`,
        fixHint: 'Remove apps, backup destinations or schedules you no longer use; each keeps up to 3 versions.',
        resource: null,
        ...FIX,
      };
    }
    return {
      id: `swarm-kv-size/${w.collection}/${w.id}`,
      check: 'swarm-kv-size',
      severity: full ? 'crit' : 'warn',
      title: full ? 'A cluster config document is full' : 'A cluster config document is nearly full',
      detail: `${w.collection}/${w.id} is ${kb(w.bytes)} of its ${kb(w.limit)} limit (${pct(w.ratio)}). At the limit swarmy refuses to save it, so changes to it stop.`,
      fixHint: 'Make it smaller: a shorter compose file, fewer rules or records in one place.',
      resource: `${w.collection}/${w.id}`,
      ...FIX,
    };
  });
}

/** The org's size warnings from its (loaded or loadable) store; no signal when the swarm can't be read. */
export async function swarmKvSizeSignal(ctx: OrgContext): Promise<SwarmKvSizeSignal | undefined> {
  try {
    const kv = swarmKvFor(ctx.hub, ctx.activeOrgId);
    if (!kv.loaded && !ctx.hub.managerNode(ctx.activeOrgId)) return undefined;
    return { warnings: kvSizeWarnings(await kv.describe(), kv.limits) };
  } catch {
    return undefined;
  }
}
