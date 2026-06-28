import { DEMO_NODES, DEMO_ORG, DEMO_SERVICES, DEMO_STACKS, DEMO_USER } from './data';
import type { DemoStore } from './types';
import { SEEDS } from './registry';

let store: DemoStore | null = null;

/** The single mutable demo world, lazily built (and domain-seeded) on first use. */
export function getStore(): DemoStore {
  if (store) return store;
  const s: DemoStore = {
    org: { ...DEMO_ORG },
    user: { ...DEMO_USER },
    nodes: DEMO_NODES.map((n) => ({ ...n })),
    services: DEMO_SERVICES.map((sv) => ({ ...sv })),
    stacks: DEMO_STACKS.map((st) => ({ ...st })),
    positions: {},
    viewport: null,
    extra: {},
  };
  for (const seed of SEEDS) seed(s);
  store = s;
  return s;
}
