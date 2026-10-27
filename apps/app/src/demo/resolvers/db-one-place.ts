import type { ResilienceProblemView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { resilience } from './resilience';

/**
 * The demo's `db-one-place` check (board 40): a production database whose
 * backups live in one place. Both seeded production databases copy to R2
 * (db-backup-copy.ts), so the list is quiet until a copy is turned off on a
 * cluster's backups, then the warning appears, as the controller's
 * `dbOnePlaceProblems` words it. Comes after resilience and dbBackupCopy.
 */

/** The demo's production apps (the storefront and its data). */
const PRODUCTION = new Set(['storefront', 'data']);

interface State {
  dbClusters: Array<{ stack: string; cluster: string; schedule: { engine: string; targetId: string | null } | null }>;
  targets: Array<{ id: string; name: string }>;
}

function onePlace(s: DemoStore, stack: string | undefined): ResilienceProblemView[] {
  const d = s.extra.data as State;
  const copies = (s.extra.dbCopy ?? {}) as Record<string, { targetId: string }>;
  return d.dbClusters
    .filter((c) => c.schedule && PRODUCTION.has(c.stack) && (!stack || c.stack === stack) && !copies[`${c.stack}/${c.cluster}`])
    .map((c) => {
      const ref = `${c.stack}/${c.cluster}`;
      const name = d.targets.find((t) => t.id === c.schedule?.targetId)?.name;
      return {
        id: `db-one-place/${ref}`,
        check: 'db-one-place',
        severity: 'warn',
        title: `Production database ${ref} has its backups in one place`,
        detail: `Every save goes to one destination${name ? ` (${name})` : ''}: if it is lost or can't be reached, nothing else can restore ${ref}.`,
        fixHint: 'Pick a second destination, ideally off-site, under “Also copy to” on its backups.',
        fixPath: `/stacks/${c.stack}/backups`,
        fixLabel: 'Add a second copy',
        resource: ref,
      };
    });
}

export const dbOnePlace: DomainResolvers = {
  handlers: {
    'resilience.overview': async (i, s) => {
      const v = (await resilience.handlers?.['resilience.overview']?.(i, s)) as { problems: ResilienceProblemView[] };
      const stack = (i as { stack?: string } | null | undefined)?.stack;
      const order = { crit: 0, warn: 1, info: 2 } as const;
      const problems = [...v.problems, ...onePlace(s, stack)].sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
      return { ...v, problems };
    },
  },
};
