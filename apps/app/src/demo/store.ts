import { DEMO_NODES, DEMO_ORG, DEMO_SERVICES, DEMO_STACKS, DEMO_USER } from './data';
import type { DemoStore } from './types';
import { freshWorld, freshenSeeds, isFreshDemo } from './fresh';
import { SEEDS } from './registry';

let store: DemoStore | null = null;

/**
 * The single mutable demo world, lazily built (and domain-seeded) on first use.
 * With `?fresh=1` (sticky for the session) it is the just-installed estate:
 * one online server and no apps, so the first-run Overview shows.
 */
export function getStore(): DemoStore {
  if (store) return store;
  const s: DemoStore = {
    org: { ...DEMO_ORG },
    user: { ...DEMO_USER },
    nodes: DEMO_NODES.map((n) => ({ ...n })),
    services: DEMO_SERVICES.map((sv) => ({ ...sv })),
    stacks: DEMO_STACKS.map((st) => ({ ...st })),
    extra: {},
  };
  const fresh = isFreshDemo();
  if (fresh) freshWorld(s);
  for (const seed of SEEDS) seed(s);
  if (fresh) freshenSeeds(s);
  store = s;
  return s;
}
