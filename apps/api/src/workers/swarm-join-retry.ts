/**
 * Swarm-join retry tick: a node that registered but whose `swarm.join` failed
 * (a slow first path to the manager, a manager mid-election) is re-planned and
 * re-sent with backoff until it joins or the attempts run out; then its node
 * page says "couldn't join the cluster: <reason>". All logic lives in
 * @swarmy/trpc swarm.service (`retryPendingSwarmJoins`); this is a scheduler.
 */
import { retryPendingSwarmJoins } from '@swarmy/trpc';

const TICK_MS = 5_000;

export function startSwarmJoinRetry(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await retryPendingSwarmJoins();
      for (const n of r.retried) console.log(`[swarm] node ${n}: retried swarm.join`);
    } catch (err) {
      console.error('[swarm] join retry tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), TICK_MS);
  return () => clearInterval(timer);
}
