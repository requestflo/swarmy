import {
  fromHeroku,
  herokuApiInput,
  herokuImportPlan,
  herokuMigrationSteps,
  parseAppConfig,
  readHerokuConfig,
  readHerokuDomains,
  type HerokuApiSnapshot,
  type HerokuInput,
} from '@swarmy/app-config';
import { herokuCopyPhrase, type HerokuImportCopyInput, type HerokuImportDeployInput, type HerokuImportPlanInput } from '@swarmy/core';
import type { HerokuDeployStep, HerokuImportView } from '@/components/heroku/heroku-types';
import type { DomainResolvers } from '../types';

/**
 * Import from Heroku in demo mode. The REAL importer runs in the browser
 * (`fromHeroku` + `herokuImportPlan`), so pasted files convert exactly as
 * the controller would; "With a Heroku token" reads northwind's Rails app
 * below instead of api.heroku.com (any token works, nothing leaves the page).
 * The view mirrors packages/trpc/src/services/heroku-import/plan.service.ts.
 */
const SNAP = (name: string): HerokuApiSnapshot => ({
  app: { name, stack: { name: 'heroku-24' } },
  formation: [
    { type: 'web', quantity: 2, size: 'Standard-2X', command: 'bundle exec puma -C config/puma.rb' },
    { type: 'worker', quantity: 1, size: 'Performance-M', command: 'bundle exec sidekiq' },
  ],
  processTypes: { web: 'bundle exec puma -C config/puma.rb', worker: 'bundle exec sidekiq', release: 'bundle exec rails db:migrate' },
  addons: [
    { addon_service: { name: 'heroku-postgresql' }, plan: { name: 'heroku-postgresql:standard-0' }, config_vars: ['HEROKU_POSTGRESQL_COBALT_URL', 'DATABASE_URL'] },
    { addon_service: { name: 'heroku-redis' }, plan: { name: 'heroku-redis:mini' }, config_vars: ['REDIS_URL'] },
    { addon_service: { name: 'scheduler' }, plan: { name: 'scheduler:standard' }, config_vars: [] },
    { addon_service: { name: 'papertrail' }, plan: { name: 'papertrail:choklad' }, config_vars: ['PAPERTRAIL_API_TOKEN'] },
  ],
  buildpacks: [{ buildpack: { url: 'heroku/ruby' } }, { buildpack: { url: 'heroku/nodejs' } }],
  configVars: {
    DATABASE_URL: 'postgres://demo:demo@ec2-0-0-0-0.compute-1.amazonaws.com:5432/demo',
    HEROKU_POSTGRESQL_COBALT_URL: 'postgres://demo:demo@ec2-0-0-0-0.compute-1.amazonaws.com:5432/demo',
    REDIS_URL: 'redis://:demo@ec2-0-0-0-0.compute-1.amazonaws.com:6379',
    SECRET_KEY_BASE: 'demo-0123456789abcdef0123456789abcdef',
    PAPERTRAIL_API_TOKEN: 'demo-papertrail-token-0123',
    RAILS_ENV: 'production',
    RAILS_SERVE_STATIC_FILES: 'enabled',
  },
  domains: [{ hostname: `${name}.herokuapp.com`, kind: 'heroku' }, { hostname: 'shop.northwind.dev', kind: 'custom' }],
});

function inputOf(src: HerokuImportPlanInput['source'], name?: string): HerokuInput {
  const base = src.kind === 'api' ? herokuApiInput(SNAP(src.app)).input : { appJson: src.appJson, procfile: src.procfile, config: src.config, domains: readHerokuDomains(src.domains ?? '') };
  return { ...base, ...(name ? { app: name } : {}) };
}

function view(src: HerokuImportPlanInput['source'], name?: string): HerokuImportView {
  const input = inputOf(src, name);
  const conv = fromHeroku(input);
  if (!conv.yaml) throw new Error(conv.notes.at(-1) ?? 'There is nothing to import.');
  const config = readHerokuConfig(input.config ?? '');
  const issues = parseAppConfig(conv.yaml).issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.line ? { line: i.line } : {}) }));
  const sealable = conv.secrets.filter((s) => config[s.key]).map((s) => s.name);
  const plan = herokuImportPlan(conv, sealable)!;
  const herokuApp = src.kind === 'api' ? src.app : conv.app;
  return {
    source: src.kind,
    herokuApp,
    app: conv.app,
    plan,
    yaml: conv.yaml,
    valid: Boolean(plan) && !issues.some((i) => i.severity === 'error'),
    issues,
    changes: conv.changes,
    steps: herokuMigrationSteps(conv, { herokuApp }),
    sealable,
    copyable: conv.databases.filter((d) => /^postgres(ql)?:\/\//.test(config[d.envVar] ?? '')).map((d) => d.resource),
  };
}

export const herokuImport: DomainResolvers = {
  handlers: {
    'herokuImport.plan': (input) => {
      const i = input as HerokuImportPlanInput;
      return view(i.source, i.name);
    },
    'herokuImport.deploy': (input) => {
      const i = input as HerokuImportDeployInput;
      const v = view(i.source, i.stack);
      const steps: HerokuDeployStep[] = [
        ...v.plan.data.map((d): HerokuDeployStep => ({ key: `resources.${d.name}`, status: 'created', say: `Started the ${d.kind === 'postgres' ? 'Postgres database' : 'cache'} “${d.name}”.` })),
        ...v.plan.secrets.map((s): HerokuDeployStep =>
          v.sealable.includes(s.name)
            ? { key: `secrets.${s.name}`, status: 'created', say: `Sealed ${s.key} as the secret ${s.name}.` }
            : { key: `secrets.${s.name}`, status: 'skipped', say: `${s.key} has no value from Heroku: add the secret ${s.name} on Variables & secrets.` },
        ),
      ];
      return { stack: v.app, steps, yaml: v.yaml };
    },
    'herokuImport.copyDatabase': (input) => {
      const i = input as HerokuImportCopyInput;
      if (i.confirm !== herokuCopyPhrase(i.stack, i.cluster)) throw new Error(`Type ${herokuCopyPhrase(i.stack, i.cluster)} to copy the data.`);
      return { stack: i.stack, cluster: i.cluster, status: 'copied', tables: 38, say: `Copied: ${i.cluster} now has 38 tables from Heroku.` };
    },
  },
};
