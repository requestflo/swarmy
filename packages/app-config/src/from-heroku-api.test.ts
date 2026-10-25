import { describe, expect, it } from 'bun:test';
import { fromHeroku } from './from-heroku';
import { herokuApiInput, type HerokuApiSnapshot } from './from-heroku-api';
import { herokuImportPlan } from './from-heroku-plan';
import { parseAppConfig } from './parse';

/** What the Platform API answers for a Rails app (trimmed to the fields swarmy reads). */
const SNAP: HerokuApiSnapshot = {
  app: { name: 'acme-shop', stack: { name: 'heroku-24' } },
  formation: [
    { type: 'web', quantity: 2, size: 'Standard-2X', command: 'bundle exec puma -C config/puma.rb' },
    { type: 'worker', quantity: 3, size: 'Performance-L', command: 'bundle exec sidekiq' },
  ],
  processTypes: { web: 'bundle exec puma -C config/puma.rb', worker: 'bundle exec sidekiq', release: 'bundle exec rails db:migrate' },
  addons: [
    { addon_service: { name: 'heroku-postgresql' }, plan: { name: 'heroku-postgresql:standard-0' }, config_vars: ['HEROKU_POSTGRESQL_COBALT_URL', 'DATABASE_URL'] },
    { addon_service: { name: 'heroku-redis' }, plan: { name: 'heroku-redis:premium-0' }, config_vars: ['REDIS_URL', 'REDIS_TLS_URL'] },
    { addon_service: { name: 'scheduler' }, plan: { name: 'scheduler:standard' }, config_vars: [] },
    { addon_service: { name: 'papertrail' }, plan: { name: 'papertrail:choklad' }, config_vars: ['PAPERTRAIL_API_TOKEN'] },
  ],
  buildpacks: [{ buildpack: { url: 'heroku/ruby', name: 'heroku/ruby' } }, { buildpack: { url: 'heroku/nodejs' } }],
  configVars: {
    DATABASE_URL: 'postgres://u:hunter2@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1',
    HEROKU_POSTGRESQL_COBALT_URL: 'postgres://u:hunter2@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1',
    REDIS_URL: 'rediss://:redispw@ec2-5-6.compute-1.amazonaws.com:6380',
    SECRET_KEY_BASE: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c',
    PAPERTRAIL_API_TOKEN: 'pt_abcdefghijklmnop',
    RAILS_ENV: 'production',
    WEB_CONCURRENCY: '2',
    UNSET: null,
  },
  domains: [
    { hostname: 'acme-shop-1a2b3c.herokuapp.com', kind: 'heroku' },
    { hostname: 'www.acme.example', kind: 'custom' },
    { hostname: 'acme.example', kind: 'custom' },
  ],
};

describe('herokuApiInput: the Platform API → the importer’s input', () => {
  const { input, gaps } = herokuApiInput(SNAP);

  it('rebuilds app.json, the Procfile (release too) and config from the API’s JSON', () => {
    expect(JSON.parse(input.appJson!)).toEqual({
      name: 'acme-shop',
      stack: 'heroku-24',
      formation: { web: { quantity: 2, size: 'Standard-2X' }, worker: { quantity: 3, size: 'Performance-L' } },
      addons: [{ plan: 'heroku-postgresql:standard-0' }, { plan: 'heroku-redis:premium-0' }, { plan: 'scheduler:standard' }, { plan: 'papertrail:choklad' }],
      buildpacks: [{ url: 'heroku/ruby' }, { url: 'heroku/nodejs' }],
    });
    expect(input.procfile).toBe('web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\nrelease: bundle exec rails db:migrate');
    expect(JSON.parse(input.config!)).not.toHaveProperty('UNSET');
    expect(input.domains).toEqual(['acme-shop-1a2b3c.herokuapp.com', 'www.acme.example', 'acme.example']);
    expect(gaps).toEqual([]);
  });

  it('a release without a slug falls back to the formation’s commands, and says the release phase is unseen', () => {
    const r = herokuApiInput({ ...SNAP, processTypes: null });
    expect(r.input.procfile).toBe('web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq');
    expect(r.gaps.map((g) => g.key)).toEqual(['release']);
  });

  it('a colour-only Postgres keeps its own variable, and the DATABASE one stays first', () => {
    const extra = { addon_service: { name: 'heroku-postgresql' }, plan: { name: 'heroku-postgresql:essential-0' }, config_vars: ['HEROKU_POSTGRESQL_RED_URL'] };
    const r = herokuApiInput({ ...SNAP, addons: [extra, SNAP.addons[0]!] });
    expect(JSON.parse(r.input.appJson!).addons).toEqual([{ plan: 'heroku-postgresql:standard-0' }, { plan: 'heroku-postgresql:essential-0', as: 'HEROKU_POSTGRESQL_RED' }]);
    const conv = fromHeroku(r.input);
    expect(conv.databases.map((d) => [d.resource, d.envVar])).toEqual([['db', 'DATABASE_URL'], ['db-red', 'HEROKU_POSTGRESQL_RED_URL']]);
  });
});

describe('the API import end to end: swarmy.yaml + the plan in plain words', () => {
  const conv = fromHeroku(herokuApiInput(SNAP).input);
  const cfg = parseAppConfig(conv.yaml!).config!;
  const plan = herokuImportPlan(conv)!;

  it('formation → copies and limits, release → the pre-deploy command, domains → routes', () => {
    expect(cfg.services.web).toMatchObject({ replicas: 2, size: 'medium', release: 'bundle exec rails db:migrate', domains: ['www.acme.example', 'acme.example'] });
    expect(cfg.services.worker).toMatchObject({ replicas: 3, memory: '14gb', cpu: 8 });
    expect(conv.yaml).not.toContain('herokuapp.com');
  });

  it('says each piece in plain words', () => {
    expect(plan.headline).toBe('acme-shop comes across as 2 services, a Postgres database and a cache.');
    expect(plan.services.map((s) => [s.name, s.role, s.say])).toEqual([
      ['web', 'web', 'Answers on its address, acme.example and www.acme.example: 2 copies, 1 CPU, 1 GB each. Runs “bundle exec rails db:migrate” before each deploy.'],
      ['worker', 'worker', 'Background work, no address: 3 copies, 8 CPU, 14 GB each.'],
    ]);
    expect(plan.data.map((d) => [d.name, d.kind, d.envVar])).toEqual([['db', 'postgres', 'DATABASE_URL'], ['cache', 'cache', 'REDIS_URL']]);
    expect(plan.data[0]!.say).toBe('A Postgres 16 database, backed up nightly. DATABASE_URL points at it.');
    expect(plan.secrets.map((s) => s.key)).toEqual(['SECRET_KEY_BASE', 'PAPERTRAIL_API_TOKEN']);
    expect(plan.plainVars).toEqual(['RAILS_ENV', 'WEB_CONCURRENCY']);
    expect(plan.domains).toEqual(['www.acme.example', 'acme.example']);
  });

  it('never drops a thing silently: Scheduler and Papertrail are listed, and no secret value reaches the file', () => {
    expect(plan.todo.map((g) => g.key)).toContain('addons: scheduler:standard');
    expect(plan.handled.map((g) => g.key)).toEqual(expect.arrayContaining(['addons: papertrail:choklad', 'domains: acme-shop-1a2b3c.herokuapp.com']));
    for (const leaked of ['hunter2', 'redispw', '9f8e7d6c', 'pt_abc']) expect(conv.yaml).not.toContain(leaked);
  });
});
