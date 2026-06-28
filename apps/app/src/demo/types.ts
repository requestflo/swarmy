import type { NodeDetail, ServiceDetail } from '@swarmy/core';

/**
 * The mutable in-memory world behind demo mode. Resolvers read and mutate this;
 * mutations feel live because components invalidate queries on success, which
 * re-runs the demo link against the just-mutated store.
 *
 * Collections are stored in their richest shape (…Detail) and resolvers project
 * down to the summary view each query returns. `extra` is a free-form bag domain
 * resolver modules use for their own collections (domains, builds, peers, …) so
 * the core store stays small.
 */
export interface DemoStore {
  org: { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member' };
  user: { id: string; name: string; email: string };
  nodes: NodeDetail[];
  services: ServiceDetail[];
  stacks: Array<{ id: string; name: string; serviceCount: number; status: string; updatedAt: string }>;
  /** canvas node positions + viewport (drag = visual only). */
  positions: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number } | null;
  /** Per-domain collections owned by resolver modules (keyed by domain name). */
  extra: Record<string, unknown>;
}

/** A query/mutation resolver: read/mutate the store, return the procedure's output. */
export type DemoHandler = (input: unknown, store: DemoStore) => unknown;

/** A subscription resolver: emit events over time; return a cleanup fn. */
export type DemoSubHandler = (
  input: unknown,
  store: DemoStore,
  emit: (data: unknown) => void,
) => () => void;

/** What each per-domain module contributes to the registry. */
export interface DomainResolvers {
  handlers?: Record<string, DemoHandler>;
  subscriptions?: Record<string, DemoSubHandler>;
  /** Optional seed run once at store creation to populate `store.extra`. */
  seed?: (store: DemoStore) => void;
}
