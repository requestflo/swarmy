import type { Tone } from '@/components/calm';
import { fmtBytes } from '@/components/buckets/format';
import { storeCount, type DataItem } from './estate-data';

/** The group for buckets no app uses yet. */
export const SHARED = 'Shared';

/** One app's cluster on "Your data, by app": its stores, a total, and whether a bucket can be dropped on it. */
export interface AppCluster {
  app: string;
  label: string;
  items: DataItem[];
  /** "4 stores and 1 bucket · 18.4 GB of files" (counts; bytes only where they're known). */
  total: string;
  /** How many services the app runs; undefined until the inventory answers. */
  services: number | undefined;
  tone: Tone;
  /** A real app: a bucket dropped here attaches to its services. */
  droppable: boolean;
}

const RANK: Partial<Record<Tone, number>> = { bad: 3, warn: 2, ok: 1 };

/** The worst tone among the items (an empty app is calm). */
export function clusterTone(items: DataItem[]): Tone {
  return items.reduce<Tone>((w, i) => ((RANK[i.tone] ?? 0) > (RANK[w] ?? 0) ? i.tone : w), 'ok');
}

/** Bytes held in buckets — the only store size swarmy knows for sure. */
export function fileBytes(items: DataItem[]): number {
  return items.reduce((n, i) => n + (i.kind === 'Bucket' ? (i.bytes ?? 0) : 0), 0);
}

export function clusterTotal(items: DataItem[]): string {
  if (items.length === 0) return 'nothing kept yet';
  const bytes = fileBytes(items);
  return `${storeCount(items)}${bytes > 0 ? ` · ${fmtBytes(bytes)} of files` : ''}`;
}

/**
 * Every app as a cluster — the ones that keep data and the ones that don't
 * yet (still somewhere to drop a bucket) — sorted by name, unattached
 * buckets last.
 */
export function buildClusters(items: DataItem[], apps: readonly string[], services: ReadonlyMap<string, number> | undefined): AppCluster[] {
  const names = [...new Set([...items.map((i) => i.app), ...apps])].sort((a, b) =>
    a === SHARED ? 1 : b === SHARED ? -1 : a.localeCompare(b),
  );
  return names
    .map((app) => {
      const mine = items.filter((i) => i.app === app);
      return {
        app,
        label: app === SHARED ? 'Not attached to an app' : app,
        items: mine,
        total: clusterTotal(mine),
        services: app === SHARED ? undefined : services?.get(app),
        tone: clusterTone(mine),
        droppable: app !== SHARED,
      };
    })
    .filter((c) => c.droppable || c.items.length > 0);
}

/** Service count per app from the live inventory, leaving out swarmy's own and ungrouped services. */
export function servicesPerApp(services: ReadonlyArray<{ stack: string }>, skip: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of services) if (!skip.includes(s.stack)) out.set(s.stack, (out.get(s.stack) ?? 0) + 1);
  return out;
}
