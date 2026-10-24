import type { DomainResolvers } from '../types';
import { clones } from './app-clone';
import { appsState } from './apps';
import { pushDemoAudit } from './auditlog';

/**
 * Remove a cloned environment, for the demo — the shape of apps/remove-env.ts.
 * Only a clone can go (production and swarmy.yaml environments are refused);
 * its lane, plans and stack disappear, its own secrets are deleted, and its
 * database is kept unless asked (the demo clone's copied `db`).
 */
export const appCloneRemove: DomainResolvers = {
  handlers: {
    'apps.removeEnvironment': (i, s) => {
      const { stack, confirm, database = 'keep' } = i as { stack: string; confirm: string; database?: 'keep' | 'delete' };
      if (confirm.trim() !== stack) throw new Error(`type ${stack} to remove this environment`);
      const all = clones(s);
      const c = all.find((x) => x.stack === stack);
      if (!c) throw new Error(`${stack} isn’t an environment the dashboard declared — production and swarmy.yaml environments are removed in the file`);
      const st = appsState(s);
      const app = st.apps.find((a) => a.repoId === c.repoId);
      if (app) delete app.envBranches[c.name];
      all.splice(all.indexOf(c), 1);
      st.plans = st.plans.filter((p) => !(p.repoId === c.repoId && p.environment === c.name && !p.prNumber));
      const row = s.stacks.find((x) => x.name === stack);
      const services = row ? s.services.filter((x) => x.stackId === row.id).map((x) => x.name) : [];
      if (row) {
        s.services = s.services.filter((x) => x.stackId !== row.id);
        s.stacks = s.stacks.filter((x) => x !== row);
      }
      const databases = c.data ? (database === 'delete' ? { kept: [], deleted: ['db'] } : { kept: ['db'], deleted: [] }) : { kept: [], deleted: [] };
      const secrets = { removed: c.slots.filter((x) => x.filled).map((x) => x.envFamily), kept: [] };
      pushDemoAudit(s, {
        action: 'app.environment.remove',
        targetType: 'gitRepo',
        targetId: c.repoId,
        metadata: { environment: c.name, stack, database, services, databases, secrets },
      });
      return { environment: c.name, stack, services, databases, secrets };
    },
  },
};
