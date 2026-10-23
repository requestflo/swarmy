import type { DemoStore, DomainResolvers } from '../types';

/**
 * Personal laptop grants (`mesh.people.grants` / `revoke`, mirror of
 * `PersonGrantView` in mesh-people.service.ts) for Mesh settings: Mei has
 * the data app's Postgres for the next half hour, Omar its Redis for the
 * afternoon. Org-wide the view carries the stack id (the controller returns
 * `targetStackId`); filtered by app it carries the app's name.
 */
interface PersonGrantView {
  id: string;
  userId: string;
  stack: string | null;
  service: string | null;
  port: number | null;
  expiresAt: string | null;
  createdAt: string;
}

const MIN = 60_000;
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();

function grants(store: DemoStore): PersonGrantView[] {
  return store.extra.meshGrants as PersonGrantView[];
}

export const meshGrants: DomainResolvers = {
  seed: (store) => {
    store.extra.meshGrants = [
      { id: 'mg-mei-postgres', userId: 'user-mei', stack: 's-data', service: 'postgres', port: 5432, expiresAt: at(25 * MIN), createdAt: at(-35 * MIN) },
      { id: 'mg-omar-redis', userId: 'user-omar', stack: 's-data', service: 'redis', port: 6379, expiresAt: at(6 * 60 * MIN), createdAt: at(-2 * 60 * MIN) },
    ] satisfies PersonGrantView[];
  },
  handlers: {
    'mesh.people.grants': (i, store): PersonGrantView[] => {
      const name = (i as { stack?: string } | undefined)?.stack;
      if (!name) return grants(store);
      const id = store.stacks.find((s) => s.name === name)?.id;
      return grants(store)
        .filter((g) => g.stack === id)
        .map((g) => ({ ...g, stack: name }));
    },
    'mesh.people.revoke': (i, store): void => {
      const { grantId } = i as { grantId: string };
      store.extra.meshGrants = grants(store).filter((g) => g.id !== grantId);
    },
  },
};
