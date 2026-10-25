import { cloneDesired, envLayers, parseAppConfig, type SecretSlot } from '@swarmy/app-config';
import type { DemoStore, DomainResolvers } from '../types';
import { apps, appsState, demoHex, demoPlan, type DemoAction } from './apps';
import { STOREFRONT_YAML } from './apps-config-file';
import { pushDemoAudit } from './auditlog';
import { CERT_READY } from './blueprint-deploys';
import { seedDemoRoute } from './ingress';

/**
 * Clone as a new environment + shared-vs-override layers, for the demo — the
 * shapes of apps/clone.ts, env-secrets.ts and env-layers.ts. The layers and
 * the secret slots come from the REAL @swarmy/app-config functions over the
 * demo swarmy.yaml; a clone is a plan row like any environment's, its stack
 * a copy of the source's services, its secrets empty until filled.
 */
export interface Clone {
  repoId: string;
  name: string;
  stack: string;
  from: string;
  data?: { mask: boolean };
  slots: Array<SecretSlot & { filled: boolean; version: number }>;
}

export const clones = (s: DemoStore): Clone[] => ((s.extra['appClones'] as Clone[] | undefined) ??= []);
const storefront = () => parseAppConfig(STOREFRONT_YAML).config!;

/** The app (and environment) a stack belongs to. */
function owner(s: DemoStore, stack: string) {
  for (const a of appsState(s).apps) {
    if (stack === a.appName) return { app: a, env: 'production' };
    const env = Object.keys(a.envBranches).find((e) => `${a.appName}-${e}` === stack);
    if (env) return { app: a, env };
  }
  return null;
}

function copyStack(s: DemoStore, from: string, to: string): void {
  const src = s.stacks.find((x) => x.name === from);
  const id = `s-${demoHex(6)}`;
  const now = new Date().toISOString();
  const services = s.services
    .filter((x) => src && x.stackId === src.id)
    .map((x) => ({ ...structuredClone(x), id: `svc-${demoHex(6)}`, swarmServiceId: `svc-${demoHex(10)}`, name: `${to}_${short(from, x.name)}`, stackId: id, replicas: { desired: 1, running: 1 }, createdAt: now, updatedAt: now }));
  s.stacks.push({ id, name: to, serviceCount: services.length, status: 'running', updatedAt: now });
  s.services.push(...services);
  // Its own stable address (clone-hosts.ts): `<service>-<stack>.<base>` for the service production serves on a domain.
  const web = services.find((x) => x.name === `${to}_web`);
  if (web) seedDemoRoute(s, { host: `web-${to}.203-0-113-10.sslip.io`, serviceId: web.id, serviceName: web.name, stack: to, port: 3000, auto: false, issuingUntil: Date.now() + CERT_READY });
}

/** `shop_web` → `web`; the demo's production services are bare (`web`). */
const short = (stack: string, name: string): string => (name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name);

export const appClone: DomainResolvers = {
  handlers: {
    // Comes after `apps` in the registry: the same list, each clone marked as the dashboard's.
    'apps.list': (i, s) => {
      const list = apps.handlers!['apps.list']!(i, s) as Array<{ repoId: string; environments: Array<{ stack: string; dashboard?: unknown }> }>;
      for (const a of list)
        for (const e of a.environments) {
          const c = clones(s).find((x) => x.stack === e.stack);
          if (c) e.dashboard = { from: c.from, ...(c.data ? { data: c.data } : {}), secretSlots: c.slots.map(({ version: _v, ...slot }) => slot) };
        }
      return list;
    },

    'apps.cloneEnvironment': (i, s) => {
      const { stack, name, branch, database, mask } = i as { stack: string; name: string; branch: string; database?: boolean; mask?: boolean };
      const found = owner(s, stack);
      if (!found) throw new Error(`git app environment "${stack}" not found`);
      const { app, env: from } = found;
      if (name === 'production' || app.envBranches[name]) throw new Error(`this app already has an environment called ${name}`);
      if (mask && !database) throw new Error('masking applies to a copied database — turn on “start its database” too');
      const to = `${app.appName}-${name}`;
      const data = database ? { mask: !!mask } : undefined;
      const desired = app.appName === 'storefront' ? cloneDesired(storefront(), { name, branch, from, ...(data ? { data } : {}) }) : null;
      const scrub = mask ? app.previewRules?.data?.scrub : undefined;
      const actions: DemoAction[] = [
        ...(database
          ? [{ id: 'resource.create:db', kind: 'resource.create', phase: 1, gate: 'auto' as const, reason: `create postgres "db" — a COPY of ${from}'s latest backup${scrub ? `, scrubbed by ${scrub}` : ''}; its own copy, kept with this environment`, name: 'db', resourceType: 'postgres' }]
          : []),
        { id: 'build:web', kind: 'build', phase: 2, gate: 'auto', reason: `Build web from ${branch}` },
        { id: 'service.deploy:web', kind: 'service.deploy', phase: 4, gate: 'auto', reason: 'Roll out web with the new image', name: 'web' },
        { id: `route.add:web-${to}.203-0-113-10.sslip.io/`, kind: 'route.add', phase: 5, gate: 'auto', reason: `Give web its own address, web-${to}.203-0-113-10.sslip.io`, host: `web-${to}.203-0-113-10.sslip.io`, path: '/' },
      ];
      const now = new Date().toISOString();
      const id = `plan-${demoHex(8)}`;
      appsState(s).plans.push(
        demoPlan({ id, repoId: app.repoId, environment: name, stack: to, sha: demoHex(40), trigger: 'clone', prNumber: null, status: 'applied', actions, issues: [], outcomes: Object.fromEntries(actions.map((a) => [a.id, { status: 'done' as const }])), error: null, confirmedIds: [], createdAt: now, appliedAt: now }),
      );
      app.envBranches[name] = branch;
      copyStack(s, stack, to);
      const slots = (desired?.dashboard?.secretSlots ?? []).map((x) => ({ ...x, filled: false, version: 0 }));
      clones(s).push({ repoId: app.repoId, name, stack: to, from, ...(data ? { data } : {}), slots });
      pushDemoAudit(s, { action: 'app.environment.clone', targetType: 'gitRepo', targetId: app.repoId, metadata: { environment: name, branch, from, stack: to, status: 'applied' } });
      return { planId: id, status: 'applied', environment: name, stack: to, declared: 'dashboard' };
    },

    'apps.setEnvironmentSecret': (i, s) => {
      const { stack, family } = i as { stack: string; family: string; value: string };
      const slot = clones(s).find((c) => c.stack === stack)?.slots.find((x) => x.family === family);
      if (!slot) throw new Error(`secret slot "${stack}/${family}" not found`);
      slot.filled = true;
      slot.version += 1;
      pushDemoAudit(s, { action: slot.version > 1 ? 'secrets.rotate' : 'secrets.create', targetType: 'secretFamily', targetId: slot.envFamily, metadata: { version: slot.version, stack } });
      return { family, envFamily: slot.envFamily, version: slot.version, services: slot.consumers.map((c) => `${stack}_${c.service}`) };
    },

    'apps.envLayers': (i, s) => {
      const { stack } = i as { stack: string };
      const found = owner(s, stack);
      if (!found) return null;
      const dashboard = clones(s).filter((c) => c.repoId === found.app.repoId).map((c) => c.name).sort();
      const plan = appsState(s).plans.find((p) => p.stack === stack && !p.prNumber);
      const base = { repoId: found.app.repoId, environment: found.env, path: found.app.configPath, sha: plan?.sha ?? '0'.repeat(40), dashboard };
      if (found.app.appName !== 'storefront') return { ...base, layers: null, reason: `${found.app.configPath} isn’t loaded in this demo` };
      return { ...base, layers: envLayers(storefront(), dashboard), reason: null };
    },
  },
};
