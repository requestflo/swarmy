/**
 * What the demo's other repos' code needs, for the Connect a repo wizard's
 * "What we found · live" (board 23): a pre-swarmy Rails app whose compose
 * runs Postgres and Redis next to it, and a monorepo root with nothing but
 * the web service. Shapes and words are what `detectAppNeeds`
 * (packages/app-config/src/scan) returns for those files.
 */
import type { AppScan, Detection } from '@/components/ci/git-scan-types';

const web = (why: string, file: string, line: number, text: string, port?: number): Detection => ({
  id: 'web',
  kind: 'web',
  name: 'web',
  maps: 'services.web',
  label: 'Web service',
  required: true,
  why,
  evidence: [{ file, line, text }],
  ...(port ? { port } : {}),
});

const LEGACY_BILLING: Detection[] = [
  web('The app itself, built from its Dockerfile, answering on port 3000.', 'Dockerfile', 14, 'EXPOSE 3000', 3000),
  { id: 'worker:worker', kind: 'worker', name: 'worker', maps: 'services.worker', label: 'Background worker', command: 'bundle exec sidekiq', why: 'Runs "bundle exec sidekiq" from the same build, with no address — it only does work in the background.', evidence: [{ file: 'Gemfile', line: 9, text: "gem 'sidekiq', '~> 7.2'" }] },
  {
    id: 'postgres',
    kind: 'postgres',
    name: 'db',
    maps: 'resources.db',
    label: 'Postgres',
    reason: 'uses ActiveRecord with PostgreSQL in config/database.yml',
    env: ['DATABASE_URL'],
    release: 'bundle exec rails db:migrate',
    why: 'A managed Postgres 16, backed up nightly. DATABASE_URL is filled in at deploy; bundle exec rails db:migrate runs before each release.',
    evidence: [
      { file: 'config/database.yml', line: 2, text: 'adapter: postgresql' },
      { file: 'Gemfile', line: 5, text: "gem 'pg', '~> 1.5'" },
      { file: 'docker-compose.yml', line: 12, text: 'image: postgres:15' },
    ],
  },
  { id: 'queue', kind: 'queue', name: 'queue', maps: 'resources.queue', label: 'Job queue (sidekiq)', reason: 'uses Sidekiq for jobs in Gemfile', env: ['REDIS_URL'], why: 'A managed Valkey set up for queues — nothing is evicted and it is saved to disk. REDIS_URL points at it.', evidence: [{ file: 'Gemfile', line: 9, text: "gem 'sidekiq', '~> 7.2'" }, { file: 'docker-compose.yml', line: 16, text: 'image: redis:7-alpine' }] },
  { id: 'cron:invoices', kind: 'cron', name: 'invoices', maps: 'jobs.invoices', label: 'Scheduled task (whenever)', reason: 'schedules it with whenever in config/schedule.rb', via: 'script', schedule: '30 4 * * *', command: 'bundle exec rake billing:invoices', why: 'Runs bundle exec rake billing:invoices at "30 4 * * *", as whenever did — change the time in jobs:.', evidence: [{ file: 'config/schedule.rb', line: 3, text: "every 1.day, at: '4:30 am' do" }] },
];

/** The scan of a folder the demo knows, for the repos `demoScan` doesn't draw. */
export function demoFolderScan(fullName: string, configPath: string): AppScan | undefined {
  if (configPath !== 'swarmy.yaml') return undefined;
  if (fullName.endsWith('/legacy-billing')) {
    return { dir: '', app: 'legacy-billing', files: 23, ms: 1630, detections: LEGACY_BILLING, build: { dockerfile: 'Dockerfile', stages: [], args: [] } };
  }
  if (fullName.endsWith('/platform')) {
    return { dir: '', app: 'platform', files: 6, ms: 1210, detections: [web('The app itself, built with zero-config (Node.js). No port found — add one to give it an address.', 'package.json', 1, '{')], build: { stages: [], args: [] } };
  }
  return undefined;
}
