import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reconcileIntegrationsNetwork, systemContext } from '@swarmy/trpc';
import { hub, store } from '../gateway';

/**
 * Integrations reconcile (QA-042): per org, keep `swarmy-integrations` holding
 * the controller plus exactly the services it dials — discovered AI engines
 * and in-swarm alert/webhook targets — so those URLs are reachable while the
 * control plane stays walled off. See `integrations-network.ts`.
 */
const TICK_MS = 60_000;

export function startIntegrationsReconcile(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const orgId of new Set(store.nodeOrg.values())) {
        const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
        try {
          const p = await reconcileIntegrationsNetwork(ctx);
          if (p.attach.length || p.detach.length || p.controller) {
            console.log(
              `[integrations] org=${orgId} attach=[${p.attach.join(', ')}] detach=[${p.detach.join(', ')}]${p.controller ? ' +controller' : ''}`,
            );
          }
        } catch (err) {
          console.error(`[integrations] org=${orgId} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 20_000);
  const timer = setInterval(() => void run(), TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
