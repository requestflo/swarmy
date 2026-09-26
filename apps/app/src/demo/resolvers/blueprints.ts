import type {
  BlueprintDeployInput,
  BlueprintDeployResultView,
  BlueprintMetaView,
  BlueprintParamsInput,
  BlueprintPlanInput,
  BlueprintPlanStepView,
  BlueprintPlanView,
  BlueprintSize,
} from '@swarmy/core';
import { APP_TEMPLATES, findAppTemplate, loadTemplate, primaryService, templateMeta } from '@swarmy/templates';
import type { DemoStore, DomainResolvers } from '../types';
import { demoDeployParts, landDemoDeploy } from './blueprint-deploys';
import { startDemoTrace } from './deploy-events';

/**
 * Blueprints demo resolvers — the Blueprints gallery (`/blueprints`): the full
 * static catalog, dry-run plan previews and a fake deploy path that lands a new
 * stack on the Applications surface. Shapes mirror `blueprints.service.ts`
 * views exactly (imported from @swarmy/core, never redeclared); the plan
 * generators are a compact mirror of the catalog in
 * `packages/trpc/src/services/blueprints/catalog.ts`. The one-click app
 * catalogue is NOT mirrored: it is the real `@swarmy/templates` data (metas via
 * `templateMeta`, plan outline from the same parsed swarmy.yaml).
 */

// ── Catalog mirror (metas match the controller catalog 1:1) ───────────────────

const opt = (
  key: string,
  label: string,
  kind: 'string' | 'boolean',
  defaultValue: string | boolean,
  help?: string,
  placeholder?: string,
): BlueprintMetaView['options'][number] => ({ key, label, kind, defaultValue, help, placeholder });

const BUILTIN_METAS: BlueprintMetaView[] = [
  {
    id: 'node-api',
    name: 'Node API',
    tagline: 'Your Node.js API with a managed Postgres wired in.',
    category: 'app',
    resources: ['Postgres', 'App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [
      opt('image', 'Image', 'string', 'ghcr.io/acme/node-api:latest', 'Your built API image.', 'ghcr.io/acme/node-api:latest'),
      opt('port', 'Port', 'string', '3000', 'The port your API listens on.', '3000'),
      opt('database', 'Managed Postgres', 'boolean', true, 'Provision a Postgres cluster and inject DATABASE_URL.'),
    ],
  },
  {
    id: 'nextjs-app',
    name: 'Next.js app',
    tagline: 'A production Next.js deployment, optionally with an uploads bucket.',
    category: 'app',
    resources: ['App', 'Bucket', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [
      opt('image', 'Image', 'string', 'ghcr.io/acme/web:latest', 'Your built Next.js (standalone) image.', 'ghcr.io/acme/web:latest'),
      opt('bucket', 'Uploads bucket', 'boolean', false, 'Create an S3 bucket and inject S3_* credentials.'),
    ],
  },
  {
    id: 'static-site',
    name: 'Static site',
    tagline: 'A static site or SPA behind swarmy ingress with automatic TLS.',
    category: 'app',
    resources: ['App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [opt('image', 'Image', 'string', 'nginx:1.27-alpine', 'An image serving your site on port 80.', 'nginx:1.27-alpine')],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    tagline: 'WordPress + MariaDB with persistent volumes and a routed domain.',
    category: 'cms',
    resources: ['MariaDB', 'Volume', 'App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [],
  },
  {
    id: 'n8n',
    name: 'n8n',
    tagline: 'Workflow automation on managed Postgres with an encrypted key store.',
    category: 'automation',
    resources: ['Postgres', 'Secret', 'App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [],
  },
  {
    id: 'directus',
    name: 'Directus',
    tagline: 'Instant headless CMS + admin app on a managed Postgres.',
    category: 'cms',
    resources: ['Postgres', 'Secret', 'App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [
      opt('adminEmail', 'Admin email', 'string', 'admin@example.com', 'First admin account.', 'admin@example.com'),
      opt('s3Uploads', 'S3 uploads bucket', 'boolean', false, 'Create a bucket and inject S3_* credentials for file storage.'),
    ],
  },
  {
    id: 'worker-with-queue',
    name: 'Worker + queue',
    tagline: 'A background worker on a managed cache, autoscaled by queue depth.',
    category: 'app',
    resources: ['Cache', 'Queue', 'Worker'],
    docOnly: false,
    supportsDomain: false,
    options: [
      opt('image', 'Image', 'string', 'ghcr.io/acme/worker:latest', 'Your BullMQ (or compatible) worker image.', 'ghcr.io/acme/worker:latest'),
      opt('queue', 'Queue name', 'string', 'jobs', 'The BullMQ queue the worker consumes.', 'jobs'),
    ],
  },
  {
    id: 'meilisearch-app',
    name: 'Meilisearch app',
    tagline: 'Lightning-fast search: Meilisearch plus your app, keys wired in.',
    category: 'data',
    resources: ['Search', 'Secret', 'App', 'Route'],
    docOnly: false,
    supportsDomain: true,
    options: [
      opt('image', 'Image', 'string', 'ghcr.io/acme/search-app:latest', 'Your app image (reads MEILI_HOST + MEILI_API_KEY).', 'ghcr.io/acme/search-app:latest'),
      opt('app', 'Deploy an app service', 'boolean', true, 'Off = Meilisearch only.'),
    ],
  },
  {
    id: 'monitoring-notes',
    name: 'Monitoring',
    tagline: 'Nothing to deploy — observability is already built into swarmy.',
    category: 'docs',
    resources: ['Docs'],
    docOnly: true,
    supportsDomain: false,
    options: [],
  },
];

const METAS: BlueprintMetaView[] = [
  ...BUILTIN_METAS.map((m) => ({ ...m, source: 'builtin' as const })),
  ...APP_TEMPLATES.map(templateMeta),
];

// ── Plan mirror ───────────────────────────────────────────────────────────────

const DB_REPLICAS: Record<BlueprintSize, number> = { s: 0, m: 1, l: 2 };
const CACHE: Record<BlueprintSize, { mb: number; topology: string; replicas: number }> = {
  s: { mb: 128, topology: 'single', replicas: 0 },
  m: { mb: 256, topology: 'replica', replicas: 1 },
  l: { mb: 1024, topology: 'replica', replicas: 2 },
};

const strOpt = (p: BlueprintParamsInput, key: string, fb: string): string => {
  const v = p.options?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fb;
};
const boolOpt = (p: BlueprintParamsInput, key: string, fb: boolean): boolean => {
  const v = p.options?.[key];
  return typeof v === 'boolean' ? v : fb;
};

const dbStep = (stack: string, size: BlueprintSize): BlueprintPlanStepView => ({
  kind: 'db.provision',
  label: 'Provision Postgres cluster',
  detail: {
    cluster: 'db',
    engine: 'postgres',
    replicas: `${DB_REPLICAS[size]} read replica${DB_REPLICAS[size] === 1 ? '' : 's'}`,
  },
});
const secretStep = (family: string): BlueprintPlanStepView => ({
  kind: 'secret',
  label: `Generate secret ${family}`,
  detail: { family, value: 'generated · write-only' },
});
const bucketStep = (name: string): BlueprintPlanStepView => ({
  kind: 'bucket',
  label: `Create bucket ${name}`,
  detail: { bucket: name },
});
const deployStep = (stack: string, services: string[]): BlueprintPlanStepView => ({
  kind: 'stack.deploy',
  label: `Deploy stack ${stack} (${services.length} service${services.length === 1 ? '' : 's'})`,
  detail: { services: services.join(', ') },
});
const routeStep = (service: string, host: string, port: number): BlueprintPlanStepView => ({
  kind: 'ingress.route',
  label: `Route https://${host} → ${service}:${port}`,
  detail: { host, service, port: String(port) },
});

/** Outline of a catalogue app's plan, from its parsed swarmy.yaml (mirrors from-app-config.ts). */
function templateSteps(id: string, p: BlueprintParamsInput): BlueprintPlanStepView[] | null {
  const t = findAppTemplate(id);
  if (!t) return null;
  const desired = loadTemplate(t, { stack: p.name, options: p.options }).desired;
  if (!desired) return [];
  const size = p.size ?? 'm';
  const steps: BlueprintPlanStepView[] = [];
  for (const r of desired.resources) {
    if (r.type === 'postgres') steps.push({ ...dbStep(p.name, size), detail: { ...dbStep(p.name, size).detail, cluster: r.name } });
  }
  for (const r of desired.resources) {
    if (r.type === 'cache') {
      steps.push({
        kind: 'cache.provision',
        label: 'Provision Valkey cache',
        detail: { cluster: r.name, engine: r.engine, memory: `${r.memoryMb} MB`, topology: CACHE[size].topology },
      });
    }
  }
  for (const name of Object.keys(t.generate ?? {})) steps.push(secretStep(`${p.name}-${name}`));
  steps.push(deployStep(p.name, desired.services.map((s) => s.name)));
  const primary = primaryService(t, desired);
  if (p.domain && primary && t.exposure !== 'private') steps.push(routeStep(primary.name, p.domain, primary.port));
  return steps;
}

function planSteps(id: string, p: BlueprintParamsInput): BlueprintPlanStepView[] {
  const fromTemplate = templateSteps(id, p);
  if (fromTemplate) return fromTemplate;
  const n = p.name;
  const size = p.size ?? 'm';
  const steps: BlueprintPlanStepView[] = [];
  switch (id) {
    case 'node-api': {
      if (boolOpt(p, 'database', true)) steps.push(dbStep(n, size));
      steps.push(deployStep(n, ['api']));
      if (p.domain) steps.push(routeStep('api', p.domain, Number(strOpt(p, 'port', '3000')) || 3000));
      break;
    }
    case 'nextjs-app': {
      if (boolOpt(p, 'bucket', false)) steps.push(bucketStep(`${n}-uploads`));
      steps.push(deployStep(n, ['web']));
      if (p.domain) steps.push(routeStep('web', p.domain, 3000));
      break;
    }
    case 'static-site': {
      steps.push(deployStep(n, ['site']));
      if (p.domain) steps.push(routeStep('site', p.domain, 80));
      break;
    }
    case 'wordpress': {
      steps.push(secretStep(`${n}-db-password`), deployStep(n, ['db', 'wordpress']));
      if (p.domain) steps.push(routeStep('wordpress', p.domain, 80));
      break;
    }
    case 'n8n': {
      steps.push(dbStep(n, size), secretStep(`${n}-encryption-key`), deployStep(n, ['n8n']));
      if (p.domain) steps.push(routeStep('n8n', p.domain, 5678));
      break;
    }
    case 'directus': {
      steps.push(dbStep(n, size), secretStep(`${n}-secret`), secretStep(`${n}-admin-password`));
      if (boolOpt(p, 's3Uploads', false)) steps.push(bucketStep(`${n}-uploads`));
      steps.push(deployStep(n, ['directus']));
      if (p.domain) steps.push(routeStep('directus', p.domain, 8055));
      break;
    }
    case 'worker-with-queue': {
      const c = CACHE[size];
      steps.push(
        {
          kind: 'cache.provision',
          label: 'Provision Valkey cache',
          detail: { cluster: 'cache', engine: 'valkey', memory: `${c.mb} MB`, topology: c.topology },
        },
        deployStep(n, ['worker']),
      );
      break;
    }
    case 'meilisearch-app': {
      const withApp = boolOpt(p, 'app', true);
      const services = withApp ? ['search', 'app'] : ['search'];
      steps.push(secretStep(`${n}-master-key`), deployStep(n, services));
      if (p.domain) {
        steps.push(withApp ? routeStep('app', p.domain, 3000) : routeStep('search', p.domain, 7700));
      }
      break;
    }
    default:
      break; // monitoring-notes: doc-only, no steps
  }
  return steps;
}

function summaryOf(stack: string, steps: BlueprintPlanStepView[]): string {
  if (steps.length === 0) return 'Nothing to deploy — this blueprint is documentation.';
  const parts = steps.map((s) => {
    switch (s.kind) {
      case 'db.provision':
        return `Postgres cluster ${stack}/db`;
      case 'cache.provision':
        return `valkey cache ${stack}/cache (${s.detail.memory ?? ''})`;
      case 'bucket':
        return `bucket ${s.detail.bucket ?? ''}`;
      case 'secret':
        return `secret ${s.detail.family ?? ''}`;
      case 'stack.deploy':
        return `stack ${stack} (${(s.detail.services ?? '').split(', ').filter(Boolean).length} services)`;
      case 'ingress.route':
        return `route ${s.detail.host ?? ''}`;
      default:
        return s.label;
    }
  });
  return `Will create: ${parts.join(', ')}.`;
}

/** The demo edge's automatic address (`<service>-<stack>.<edge-ip>.sslip.io`, as auto-address.ts forms it). */
function demoAutoHost(id: string, stack: string): string | null {
  const t = findAppTemplate(id);
  if (!t || t.exposure === 'private') return null;
  const desired = loadTemplate(t, { stack }).desired;
  const primary = desired ? primaryService(t, desired) : null;
  if (!primary) return null;
  const label = `${primary.name}-${stack}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${label}.203-0-113-10.sslip.io`;
}

const rand = (): string => Math.random().toString(36).slice(2, 12);

// ── Resolvers ─────────────────────────────────────────────────────────────────

export const blueprints: DomainResolvers = {
  handlers: {
    'blueprints.list': (): BlueprintMetaView[] => METAS,

    'blueprints.plan': (i): BlueprintPlanView => {
      const { id, params } = i as BlueprintPlanInput;
      const steps = planSteps(id, params);
      return {
        id,
        stackName: params.name,
        summary: summaryOf(params.name, steps),
        steps,
        ...(params.domain ? {} : { autoHost: demoAutoHost(id, params.name) }),
      };
    },

    'blueprints.deploy': (i, s: DemoStore): BlueprintDeployResultView => {
      const { id, params } = i as BlueprintDeployInput;
      const meta = METAS.find((m) => m.id === id);
      if (!meta || meta.docOnly) throw new Error(`blueprint "${id}" is documentation — nothing to deploy`);
      if (s.stacks.some((st) => st.name === params.name)) {
        throw new Error(`stack "${params.name}" already exists — pick another name`);
      }
      const steps = planSteps(id, params);
      const results = steps.map((step) => ({
        kind: step.kind,
        label: step.label,
        status: 'succeeded' as const,
        detail:
          step.kind === 'stack.deploy'
            ? `Stack ${params.name} deployed · ${step.detail.services ?? ''}`
            : step.kind === 'ingress.route'
              ? `https://${step.detail.host} → ${step.detail.service}:${step.detail.port}`
              : step.label,
        error: null,
      }));
      const serviceCount =
        (steps.find((st) => st.kind === 'stack.deploy')?.detail.services ?? '')
          .split(', ')
          .filter(Boolean).length || 1;
      const stackId = `stk-${rand()}`;
      s.stacks = [
        { id: stackId, name: params.name, serviceCount, status: 'deploying', updatedAt: new Date().toISOString() },
        ...s.stacks,
      ];
      // The app's services start at 0/1 and come up over ~15 s (blueprint-deploys.ts), with an address.
      const planServices = (steps.find((st) => st.kind === 'stack.deploy')?.detail.services ?? '').split(', ').filter(Boolean);
      const route = steps.find((st) => st.kind === 'ingress.route');
      const parts = demoDeployParts(id, params.name, params.options, planServices, route ? { service: route.detail.service ?? '', port: Number(route.detail.port) || 80 } : null);
      const host = landDemoDeploy(s, {
        stackId,
        stack: params.name,
        parts,
        domain: params.domain,
        exposed: meta.supportsDomain && findAppTemplate(id)?.exposure !== 'private',
      });
      // The deploy's own event stream (deploys.events), on the same clock.
      const deployId = startDemoTrace(s, {
        stack: params.name,
        parts,
        host,
        dataSteps: steps.filter((st) => ['db.provision', 'cache.provision', 'bucket', 'secret'].includes(st.kind)).map((st) => st.label),
        node: s.nodes.find((n) => n.id === 'n-wkr-1')?.name ?? 'wkr-1',
      });
      const url = params.domain && meta.supportsDomain ? `https://${params.domain}` : null;
      const notes =
        id === 'directus'
          ? [
              `Directus admin login — ${strOpt(params, 'adminEmail', 'admin@example.com')} / ${rand()}${rand()} (shown once, save it now)`,
            ]
          : (findAppTemplate(id)?.reveal ?? [])
              .map((r) => r.replace(/\$\{\{\s*secrets\.[a-z0-9-]+\s*\}\}/g, () => `${rand()}${rand()}`))
              .concat((meta.postDeploy ?? []).map((line) => line.replaceAll('<url>', url ?? 'the app URL')));
      return {
        id,
        stackName: params.name,
        ok: true,
        steps: results,
        url,
        notes,
        deployId,
      };
    },
  },
};
