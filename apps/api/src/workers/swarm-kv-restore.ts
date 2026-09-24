/**
 * swarm-kv restore drain (plans/epic-docker-native-state.md P4).
 *
 * A controller restore brings back control.db AND the infra config that lives
 * in the swarm (swarm-kv documents), possibly onto a brand-new swarm. The
 * disaster-restore CLI has no agent connection, so it stashes the documents in
 * `pending-swarm-kv.json` next to control.db; an in-place restore stashes the
 * orgs whose manager wasn't connected yet. This loop writes each org's
 * documents back as soon as its manager agent is online. Until then that org's
 * store reads as unavailable, so no reconciler converges on an empty config.
 */
import { dirname } from 'node:path';
import { resolveDbPaths } from '@swarmy/db';
import { importPendingKv } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 5_000;

export function startSwarmKvRestore(): () => void {
  const dataDir = dirname(resolveDbPaths().control);
  let running = false;
  let done = false;
  const tick = async (): Promise<void> => {
    if (running || done) return;
    running = true;
    try {
      const res = await importPendingKv(hub, dataDir);
      if (res === null) {
        done = true; // nothing (left) to restore
        return;
      }
      if (res.written > 0) console.log(`[swarm-kv-restore] wrote ${res.written} restored document(s)`);
      if (res.pending.length === 0) done = true;
    } catch (err) {
      console.error('[swarm-kv-restore] tick failed:', err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
