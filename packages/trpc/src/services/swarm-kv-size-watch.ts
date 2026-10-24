/**
 * Logs swarm-kv documents (and each org's whole footprint) nearing their size
 * limits: once when an org's store has loaded, then whenever the picture
 * changes (a new document over 75%, a 5% step, or back under). It reads the
 * loaded cache only (never loads a store itself; the warm-up does that), so a
 * pass costs no Docker round-trip. Resilience shows the same warnings as the
 * `swarm-kv-size` check.
 */
import { KV_WARN_RATIO, kvSizeKey, kvSizeLogLine, kvSizeWarnings, type KvSizeWarning } from '@swarmy/core';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { reachableOrgIds } from './kv-repo';
import { swarmKvFor } from './swarm-kv.service';

export interface KvSizeWatchOptions {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** How often one org is re-measured (ms). */
  everyMs?: number;
  now?: () => number;
}

export function createKvSizeWatch(scope: { hub: AgentHub; db: DB }, opts: KvSizeWatchOptions = {}) {
  /* eslint-disable no-console */
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const everyMs = opts.everyMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const last = new Map<string, { at: number; key: string }>();

  return {
    /** Measure the orgs that are due; returns those whose warnings changed. */
    async tick(): Promise<Array<{ orgId: string; warnings: KvSizeWarning[] }>> {
      const out: Array<{ orgId: string; warnings: KvSizeWarning[] }> = [];
      for (const orgId of await reachableOrgIds(scope)) {
        const kv = swarmKvFor(scope.hub, orgId);
        if (!kv.loaded) continue;
        const prev = last.get(orgId);
        if (prev && now() - prev.at < everyMs) continue;
        const warnings = kvSizeWarnings(await kv.describe().catch(() => []), kv.limits);
        const key = kvSizeKey(warnings);
        last.set(orgId, { at: now(), key });
        if (key === (prev?.key ?? '')) continue;
        out.push({ orgId, warnings });
        if (warnings.length === 0) {
          log(`[swarm-kv] org ${orgId}: config sizes are back under ${Math.round(KV_WARN_RATIO * 100)}% of their limits`);
        }
        for (const w of warnings) warn(kvSizeLogLine(orgId, w));
      }
      return out;
    },
  };
}
