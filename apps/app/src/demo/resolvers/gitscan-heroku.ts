/**
 * Demo of "Looks like a Heroku app" (board 24): northwind/shop-classic, a
 * Rails app with a Procfile and an app.json. The shapes mirror
 * packages/trpc/src/services/git-scan-heroku.ts (HerokuScanView), and the
 * text is what `fromHeroku` + `herokuMigrationSteps` produce for it.
 */
import type { AppScan, Detection, HerokuScan } from '@/components/ci/git-scan-types';

const APP = 'shop-classic';
const ev = (file: string, line: number, text: string) => ({ file, line, text });
const PROCFILE = [ev('Procfile', 1, 'web: bundle exec puma -C config/puma.rb'), ev('Procfile', 2, 'worker: bundle exec sidekiq -C config/sidekiq.yml'), ev('Procfile', 3, 'release: bundle exec rails db:migrate')];
const build = ['    build:', '      type: railpack', '      path: .', '      packages:', '        - node'];

const YAML = [
  '# Imported from Heroku (app.json + Procfile) by swarmy — review it, then commit it.',
  '# Secret values stay out of git: the file reads them as ${{ secrets.<name> }}.',
  '',
  'version: 1',
  `app: ${APP}`,
  'env:',
  '  DATABASE_URL: ${{ db.url }}',
  '  REDIS_URL: ${{ cache.url }}',
  '  REDIS_TLS_URL: ${{ cache.url }}',
  '  SECRET_KEY_BASE: ${{ secrets.secret-key-base }}',
  '  RAILS_ENV: production',
  '  RAILS_SERVE_STATIC_FILES: enabled',
  'services:',
  '  web:',
  ...build,
  '    command: bundle exec puma -C config/puma.rb',
  '    port: 5000',
  '    release: bundle exec rails db:migrate',
  '    replicas: 2',
  '    size: medium',
  '  worker:',
  ...build,
  '    command: bundle exec sidekiq -C config/sidekiq.yml',
  '    replicas: 1',
  '    size: small',
  'resources:',
  '  db:',
  '    type: postgres',
  '    version: 16',
  '  cache: cache',
  '',
].join('\n');

const HEROKU: HerokuScan = {
  label: 'Looks like a Heroku app',
  why: "swarmy.yaml comes from app.json and the Procfile: 2 process types and 1 database. 3 things didn't come across — each says what to do.",
  evidence: [...PROCFILE, ev('app.json', 13, '"addons": [')],
  draft: {
    yaml: YAML,
    valid: true,
    issues: [],
    notes: [],
    graph: {
      stack: APP,
      services: [
        { name: 'web', meta: 'build · :5000 · 2 copies', wires: ['cache', 'db'] },
        { name: 'worker', meta: 'build · no address · 1 copy', wires: ['cache', 'db'] },
      ],
      data: [
        { name: 'cache', meta: 'valkey · 256 MB' },
        { name: 'db', meta: 'postgres 16 · backed up daily' },
      ],
      jobs: [],
    },
  },
  changes: [
    'heroku/nodejs is a second language, so the build adds it as a tool (build.packages: node).',
    'The web process becomes services.web: it reads $PORT as it did on Heroku, and swarmy sets PORT=5000.',
    'The release phase (bundle exec rails db:migrate) runs before each deploy, in the new image (services.web.release).',
    'worker becomes a background worker, services.worker, with no address.',
    'web ran on standard-2x dynos: size: medium.',
    'heroku-postgresql:standard-0 becomes a managed Postgres 16 "db" — swarmy runs it and backs it up nightly; DATABASE_URL is filled in at deploy.',
    "heroku-redis:mini becomes a managed cache \"cache\" (Valkey, Redis-compatible); REDIS_URL points at it, on the app's private network.",
  ],
  untranslated: [
    { key: 'buildpacks: heroku/ruby', reason: 'Railpack detects the language and builds it the way the buildpack did', handled: true },
    { key: 'addons: papertrail:choklad', reason: "swarmy collects every service's logs itself", handled: true },
    { key: 'addons: scheduler:standard', reason: "Heroku Scheduler keeps its jobs in its dashboard, not app.json: add each one under jobs: with its schedule and command (they run in web's image and env)" },
    { key: 'scripts.postdeploy', reason: 'it ran once, after Heroku first made the app, and swarmy.yaml has no one-time hook: run "bundle exec rails db:seed" yourself after the first deploy (release: runs on every deploy)' },
    { key: 'env.SECRET_KEY_BASE', reason: 'Heroku generated it when the app was made: create the swarmy secret secret-key-base with its value from heroku config (the file reads ${{ secrets.secret-key-base }})' },
  ],
  steps: {
    data: [
      {
        title: 'Back up the Heroku database and download it',
        where: 'terminal',
        lines: [`export HEROKU_APP=${APP}   # the app's name on Heroku`, 'heroku pg:backups:capture DATABASE --app "$HEROKU_APP"', 'mkdir -p backup', 'heroku pg:backups:download --app "$HEROKU_APP" --output backup/dump.pgc'],
        note: 'Heroku keeps running and nothing there changes. db runs Postgres 16: pg_restore loads a dump from the same or an older Postgres, never a newer one.',
      },
      {
        title: "Add it to db's backups",
        where: 'terminal',
        lines: [
          '# the destination db backs up to (Data › Backups): its repository, password and keys',
          'export RESTIC_REPOSITORY=s3:<endpoint>/<bucket>/<prefix> RESTIC_PASSWORD=<password> AWS_ACCESS_KEY_ID=<key-id> AWS_SECRET_ACCESS_KEY=<secret>',
          'docker run --rm -v "$PWD/backup:/backup:ro" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \\',
          `  restic/restic:0.16.4 backup /backup --tag db:${APP}/db --tag engine:pg_dump --tag reason:heroku-import`,
        ],
        note: "Heroku's file is a pg_dump -Fc dump, the same kind swarmy's own backups of db store, so it lands where theirs do and the Backups tab lists it. Run it anywhere that reaches the destination.",
      },
      {
        title: 'Restore it into db',
        where: 'dashboard',
        lines: [`${APP} › Backups → db → the heroku-import copy → Restore in place`],
        note: "swarmy saves db's current data first, then loads the dump with pg_restore --clean --if-exists --no-owner. Anything written on Heroku after the backup stays there, so take it just before you switch over.",
      },
    ],
    config: [
      {
        title: 'Export the config vars',
        where: 'terminal',
        lines: [`heroku config --shell --app "$HEROKU_APP" | grep -v -E '^(DATABASE_URL|REDIS_URL|REDIS_TLS_URL)=' > heroku.env`],
        note: "DATABASE_URL, REDIS_URL, REDIS_TLS_URL stay behind: swarmy fills in its own. heroku.env holds secret values, so keep it out of git and delete it when you're done.",
      },
      {
        title: 'Paste it into web',
        where: 'dashboard',
        lines: [`${APP} › Config › Variables & secrets › Paste .env → web`],
        note: 'Paste .env keeps secret-looking values secret and shows every change before it deploys. swarmy.yaml reads one of them as a swarmy secret (secret-key-base): add it on Variables & secrets as a secret with that name.',
      },
    ],
  },
};

/** The generic detections the same scan finds (they write the swarmy.yaml once the import is unticked). */
const DETECTIONS: Detection[] = [
  { id: 'web', kind: 'web', name: 'web', maps: 'services.web', label: 'Web service', required: true, why: 'The app itself, built with zero-config (Ruby). No port found — add one to give it an address.', evidence: [PROCFILE[0]!] },
  { id: 'worker:worker', kind: 'worker', name: 'worker', maps: 'services.worker', label: 'Background worker', command: 'bundle exec sidekiq -C config/sidekiq.yml', why: 'Runs "bundle exec sidekiq -C config/sidekiq.yml" from the same build, with no address — it only does work in the background.', evidence: [PROCFILE[1]!] },
  { id: 'postgres', kind: 'postgres', name: 'db', maps: 'resources.db', label: 'Postgres', env: ['DATABASE_URL'], release: 'bundle exec rails db:migrate', why: 'A managed Postgres 16, backed up nightly. DATABASE_URL is filled in at deploy; bundle exec rails db:migrate runs before each release.', evidence: [ev('Gemfile', 3, "gem 'pg'"), ev('app.json', 14, '"heroku-postgresql:standard-0",'), PROCFILE[2]!] },
  { id: 'queue', kind: 'queue', name: 'queue', maps: 'resources.queue', label: 'Job queue (sidekiq)', env: ['REDIS_URL'], why: 'A managed Valkey set up for queues — nothing is evicted and it is saved to disk. REDIS_URL points at it.', evidence: [ev('Gemfile', 4, "gem 'sidekiq'")] },
];

export function demoHerokuScan(): AppScan {
  return { dir: '', app: APP, files: 4, ms: 1210, detections: DETECTIONS, build: { stages: [], args: [] }, heroku: HEROKU };
}
