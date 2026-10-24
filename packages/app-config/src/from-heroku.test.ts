import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { fromHeroku, type HerokuInput } from './from-heroku';
import { parseAppConfig } from './parse';

const APP_JSON = JSON.stringify({
  name: 'Acme Shop',
  stack: 'heroku-24',
  env: { SECRET_KEY_BASE: { generator: 'secret' }, RAILS_ENV: { value: 'production' }, STRIPE_SECRET_KEY: { required: true }, LOG_LEVEL: 'info' },
  formation: { web: { quantity: 2, size: 'standard-2x' }, worker: { quantity: 1, size: 'performance-m' } },
  addons: ['heroku-postgresql:premium-0', { plan: 'heroku-redis:mini' }, 'scheduler:standard', 'papertrail'],
  buildpacks: [{ url: 'heroku/ruby' }, { url: 'heroku/nodejs' }, { url: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' }],
  scripts: { postdeploy: 'bundle exec rake db:seed' },
  cron: [{ command: 'bundle exec rake invoices:send', schedule: '@daily' }],
  environments: { review: {} },
});
const PROCFILE = 'web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\nrelease: bundle exec rails db:migrate\nclock: bundle exec clockwork clock.rb\n';
const CONFIG = `=== acme-shop Config Vars
DATABASE_URL:              postgres://u:hunter2@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1
HEROKU_POSTGRESQL_RED_URL: postgres://u:hunter2@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1
REDIS_URL:                 redis://h:redispw@ec2.compute.amazonaws.com:6379
SECRET_KEY_BASE:           9f8e7d6c5b4a3f2e1d
STRIPE_SECRET_KEY:         sk_live_abcdefghijklmnop
RAILS_ENV:                 production
WEB_CONCURRENCY:           2
HEROKU_SLUG_COMMIT:        abc123
PORT:                      12345
`;

/** Convert, then prove it with the parser the controller runs on push and the planner after it. */
function roundTrip(input: HerokuInput) {
  const r = fromHeroku(input);
  expect(r.yaml).not.toBeNull();
  const parsed = parseAppConfig(r.yaml!);
  expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return { ...r, cfg: parsed.config!, desired: toDesired(parsed.config!) };
}

describe('fromHeroku: a Rails app with Postgres, Redis, a worker and a clock', () => {
  const r = roundTrip({ appJson: APP_JSON, procfile: PROCFILE, config: CONFIG, app: 'acme-shop' });

  it('maps process types: web with a port and the release command, other types as workers', () => {
    expect(r.cfg.services.web).toMatchObject({ command: 'bundle exec puma -C config/puma.rb', port: 5000, release: 'bundle exec rails db:migrate', replicas: 2, size: 'medium' });
    expect(r.cfg.services.worker).toMatchObject({ command: 'bundle exec sidekiq', replicas: 1, memory: '2560mb' });
    expect(r.cfg.services.clock).toMatchObject({ command: 'bundle exec clockwork clock.rb', replicas: 1 });
    const web = r.desired.services.find((s) => s.name === 'web')!;
    expect(web.release).toEqual(['sh', '-c', 'bundle exec rails db:migrate']);
    expect(web.command).toEqual(['sh', '-c', 'bundle exec puma -C config/puma.rb']);
    expect(web.env.PORT).toBe('5000');
    expect(r.desired.services.map((s) => s.dependsOn)).toEqual([['cache', 'db'], ['cache', 'db'], ['cache', 'db']]);
  });

  it('buildpacks become one Railpack build: a second language as a tool, ffmpeg as apt', () => {
    expect(r.cfg.services.web!.build).toEqual({ type: 'railpack', path: '.', packages: ['node'], apt: ['ffmpeg'] });
    expect(r.desired.services[0]!.source).toMatchObject({ kind: 'build', builder: 'railpack' });
  });

  it('add-ons become managed resources and their URLs bindings; review apps become previews; cron becomes jobs', () => {
    expect(r.cfg.resources).toEqual({ db: { type: 'postgres', version: 16, ha: 'failover' }, cache: 'cache' });
    expect(r.cfg.env).toMatchObject({ DATABASE_URL: '${{ db.url }}', HEROKU_POSTGRESQL_RED_URL: '${{ db.url }}', REDIS_URL: '${{ cache.url }}', REDIS_TLS_URL: '${{ cache.url }}' });
    expect(r.cfg.jobs).toEqual({ 'invoices-send': { schedule: '0 0 * * *', service: 'web', run: 'bundle exec rake invoices:send' } });
    expect(r.cfg.previews).toEqual({ enabled: true });
    expect(r.databases).toEqual([{ resource: 'db', envVar: 'DATABASE_URL', version: 16 }]);
    expect(r.bound).toEqual(['DATABASE_URL', 'REDIS_URL', 'REDIS_TLS_URL', 'HEROKU_POSTGRESQL_RED_URL']);
  });

  it('config vars become env; secret-looking values become ${{ secrets.<name> }} and never land in the file', () => {
    expect(r.cfg.env).toMatchObject({
      RAILS_ENV: 'production',
      LOG_LEVEL: 'info',
      WEB_CONCURRENCY: '2',
      SECRET_KEY_BASE: '${{ secrets.secret-key-base }}',
      STRIPE_SECRET_KEY: '${{ secrets.stripe-secret-key }}',
    });
    expect(r.secrets).toEqual([{ key: 'SECRET_KEY_BASE', name: 'secret-key-base' }, { key: 'STRIPE_SECRET_KEY', name: 'stripe-secret-key' }]);
    for (const leaked of ['hunter2', 'redispw', 'amazonaws', '9f8e7d6c5b4a', 'sk_live', 'abc123', '12345']) expect(r.yaml).not.toContain(leaked);
    expect(r.cfg.env).not.toHaveProperty('PORT');
    expect(r.cfg.env).not.toHaveProperty('HEROKU_SLUG_COMMIT');
  });

  it('says what did not translate, each with why', () => {
    const why = (key: string) => r.untranslated.find((g) => g.key === key);
    expect(why('addons: papertrail')).toMatchObject({ handled: true, reason: "swarmy collects every service's logs itself" });
    expect(why('addons: scheduler:standard')?.reason).toContain('dashboard');
    expect(why('scripts.postdeploy')?.reason).toContain('run "bundle exec rake db:seed" yourself after the first deploy');
    expect(why('config.STRIPE_SECRET_KEY')?.reason).toContain('create the swarmy secret stripe-secret-key');
    expect(why('config.PORT')).toMatchObject({ handled: true });
    expect(why('stack: heroku-24')).toMatchObject({ handled: true });
    expect(r.notes).toContain("addons: papertrail isn't carried over — swarmy collects every service's logs itself.");
    expect(r.notes).toEqual(expect.arrayContaining(r.changes));
  });
});

describe('fromHeroku: smaller apps', () => {
  it('a Procfile alone: a literal port, workers, no resources', () => {
    const r = roundTrip({ procfile: 'web: gunicorn app:app --bind 0.0.0.0:8000\nurgent_worker: rq worker high\n', app: 'tiny' });
    expect(r.cfg.services).toEqual({
      web: { build: { type: 'railpack', path: '.' }, command: 'gunicorn app:app --bind 0.0.0.0:8000', port: 8000 },
      'urgent-worker': { build: { type: 'railpack', path: '.' }, command: 'rq worker high' },
    });
    expect(r.cfg.resources).toBeUndefined();
  });

  it('app.json without a Procfile: Railpack starts it; the folder is the build path', () => {
    const r = roundTrip({ appJson: '{"addons":["heroku-postgresql"],"env":{"PORT":{"value":"3000"}}}', dir: 'apps/api', app: 'api' });
    expect(r.cfg.services.web).toEqual({ build: { type: 'railpack', path: 'apps/api' }, port: 3000 });
    expect(r.cfg.env).toEqual({ DATABASE_URL: '${{ db.url }}' });
  });

  it('infers Postgres and Redis from heroku config when app.json lists no add-ons, in --shell and --json form', () => {
    const shell = "DATABASE_URL='postgres://u:p@h:5432/d'\nREDIS_URL='rediss://:p@h:6380'\nAPP_MODE='live'\n";
    const json = '{"DATABASE_URL":"postgres://u:p@h:5432/d","REDIS_URL":"rediss://:p@h:6380","APP_MODE":"live"}';
    const a = roundTrip({ procfile: 'web: node server.js', config: shell });
    const b = roundTrip({ procfile: 'web: node server.js', config: json });
    expect(a.cfg.resources).toEqual({ db: { type: 'postgres', version: 16 }, cache: 'cache' });
    expect(a.cfg.env).toEqual({ DATABASE_URL: '${{ db.url }}', REDIS_URL: '${{ cache.url }}', REDIS_TLS_URL: '${{ cache.url }}', APP_MODE: 'live' });
    expect(b.cfg).toEqual(a.cfg);
  });

  it('a named second Postgres binds its own URL; an unsupported version starts on 16 with a gap', () => {
    const r = roundTrip({
      procfile: 'web: node server.js',
      appJson: JSON.stringify({ addons: [{ plan: 'heroku-postgresql:standard-0', options: { version: '13' } }, { plan: 'heroku-postgresql', as: 'ANALYTICS_DB' }] }),
    });
    expect(r.cfg.resources).toEqual({ db: { type: 'postgres', version: 16 }, 'analytics-db': { type: 'postgres', version: 16 } });
    expect(r.cfg.env).toEqual({ DATABASE_URL: '${{ db.url }}', ANALYTICS_DB_URL: '${{ analytics-db.url }}' });
    expect(r.untranslated.find((g) => g.key.startsWith('addons: heroku-postgresql:standard-0'))?.reason).toContain('starts on 16');
  });

  it('a literal ${{ in a value is escaped, unknown buildpacks are gaps', () => {
    const r = roundTrip({ procfile: 'web: node s.js', config: 'GREETING=hi ${{ there }}\n', appJson: '{"buildpacks":[{"url":"heroku/scala"},{"url":"heroku/heroku-buildpack-pgbouncer"}]}' });
    expect(r.cfg.env?.GREETING).toBe('hi $${{ there }}');
    expect(r.untranslated.map((g) => g.key)).toEqual(expect.arrayContaining(['buildpacks: heroku/scala', 'buildpacks: heroku/heroku-buildpack-pgbouncer']));
  });

  it('refuses junk', () => {
    expect(fromHeroku({ appJson: '{ not json' }).yaml).toBeNull();
    expect(fromHeroku({ appJson: '[]' }).notes).toEqual(['app.json is not a JSON object.']);
    expect(fromHeroku({}).yaml).toBeNull();
  });
});
