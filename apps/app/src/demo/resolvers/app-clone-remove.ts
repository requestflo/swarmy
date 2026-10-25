import type { DomainResolvers } from '../types';
import { clones } from './app-clone';
import { appsState } from './apps';
import { pushDemoAudit } from './auditlog';
import { dropDemoRoutes } from './ingress';

/**
 * Remove a cloned environment, for the demo — the shape of apps/remove-env.ts.
 * Only a clone can go (production and swarmy.yaml environments are refused);
 * its lane, plans, stack and addresses disappear, its own secrets are
 * deleted, and its data (the demo clone's copied `db`) is kept — marked left
 * over — unless asked.
 */
export const appCloneRemove: DomainResolvers = {
  handlers: {
    'apps.removeEnvironment': (i, s) => {
      const { stack, confirm, data = 'keep' } = i as { stack: string; confirm: string; data?: 'keep' | 'delete' };
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
      const hosts = dropDemoRoutes(s, stack);
      const keep = data === 'keep';
      const databases = c.data ? (keep ? { kept: ['db'], deleted: [] } : { kept: [], deleted: ['db'] }) : { kept: [], deleted: [] };
      const vols = [`${stack}_web-uploads`];
      const volumes = keep ? { kept: vols, deleted: [] } : { kept: [], deleted: vols };
      const secrets = { removed: c.slots.filter((x) => x.filled).map((x) => x.envFamily), kept: [] };
      const result = { environment: c.name, stack, services, hosts, databases, volumes, secrets };
      pushDemoAudit(s, {
        action: 'app.environment.remove',
        targetType: 'gitRepo',
        targetId: c.repoId,
        metadata: { ...result, data, ...(keep ? { orphanMarker: `swarmy-orphaned.${stack}.demo01` } : {}) },
      });
      return result;
    },
  },
};
