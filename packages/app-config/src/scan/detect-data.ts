/**
 * Data the app needs: Postgres and a Redis-compatible cache or BullMQ-style
 * queue (S3 is detect-bucket.ts). Each becomes a managed resource; the env
 * vars the app already reads are bound to it (`DATABASE_URL: ${{ db.url }}`),
 * and the finding says why in plain words.
 */
import type { Fact, ScanCtx } from './context';
import { found, imageMatch, type Signal } from './signals';
import type { Detection, Evidence } from './types';

export { uniqEvidence } from './signals';

export const names = (facts: Fact[]): string[] => [...new Set(facts.map((f) => f.name))].slice(0, 6);

const PG_DRIVERS = ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'github.com/lib/pq', 'github.com/jackc/pgx/v5', 'github.com/jackc/pgx/v4'];
/** ORMs that point at "a SQL database" — Postgres on swarmy unless the repo says otherwise. */
const PG_ORMS = ['prisma', '@prisma/client', 'drizzle-orm', 'sqlalchemy', 'flask-sqlalchemy', 'sqlmodel'];
const ORM_NAME: Record<string, string> = { prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle', sqlalchemy: 'SQLAlchemy', 'flask-sqlalchemy': 'SQLAlchemy', sqlmodel: 'SQLModel' };
const PG_URL_VAR = /^(DATABASE|POSTGRES(QL)?|PG|DB)(_[A-Z0-9]+)*_URL$|^DIRECT_URL$/;
const NOT_PG = /^(mysql|mariadb|sqlite|file|mongodb(\+srv)?|sqlserver):/i;
const PG_IMAGE = /^(postgres|postgis\/postgis|pgvector\/pgvector|timescale\/timescaledb[\w-]*|bitnami\/postgresql|supabase\/postgres)(:|@|$)/;
const OTHER_DB_IMAGE = /^(mysql|mariadb|mongo|bitnami\/(mysql|mariadb|mongodb))(:|@|$)/;

/** `github.com/jackc/pgx/v5` → `jackc/pgx`; anything else as named. */
export const depWords = (name: string): string => (name.startsWith('github.com/') ? name.split('/').slice(1, 3).join('/') : name);

function pgDriverWords(c: ScanCtx, d: Fact): string {
  if (d.ev.file.endsWith('Gemfile')) return c.dep('rails', 'activerecord') ? 'uses ActiveRecord with the pg adapter' : 'uses the pg gem';
  if (d.name.startsWith('psycopg')) return 'uses psycopg';
  return d.name.includes('/') ? `uses ${depWords(d.name)}` : `uses the ${d.name} driver`;
}

export function detectPostgres(c: ScanCtx): Detection | null {
  const provider = c.find('prisma/schema.prisma', /provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/);
  const urlVars = c.dotenv.filter((e) => PG_URL_VAR.test(e.name));
  const dbConn = c.dotenv.find((e) => e.name === 'DB_CONNECTION');
  const railsDb = c.find('config/database.yml', /^\s*adapter\s*:\s*['"]?(\w+)/);
  if ((provider && provider.value !== 'postgresql') || urlVars.some((e) => NOT_PG.test(e.value))) return null;
  if ((dbConn && dbConn.value !== 'pgsql') || (railsDb && !/^postgres/.test(railsDb.value))) return null;
  const driver = c.dep(...PG_DRIVERS);
  const orm = c.dep(...PG_ORMS);
  const image = imageMatch(c.compose, PG_IMAGE);
  const drizzle = c.find('drizzle.config.ts', /(dialect|driver)\s*:\s*['"](postgresql|pg)['"]/) ?? c.find('drizzle.config.js', /(dialect|driver)\s*:\s*['"](postgresql|pg)['"]/);
  const pgUrl = urlVars.find((e) => /^postgres(ql)?:/i.test(e.value));
  const read = c.reads.find((r) => PG_URL_VAR.test(r.name));
  const strong: Signal[] = [
    { ev: provider?.ev, says: 'uses Prisma with PostgreSQL' },
    { ev: railsDb?.ev, says: 'uses ActiveRecord with PostgreSQL' },
    { ev: drizzle?.ev, says: 'uses Drizzle with PostgreSQL' },
    { ev: driver?.ev, says: driver ? pgDriverWords(c, driver) : '' },
    { ev: image?.image?.ev, says: `runs ${image?.image?.value} as ${image?.name}` },
    { ev: pgUrl?.ev, says: `sets ${pgUrl?.name} to a postgres:// address` },
    { ev: dbConn?.ev, says: 'uses Laravel with pgsql' },
    { ev: c.find('app.json', /heroku-postgresql/)?.ev, says: 'asks Heroku for heroku-postgresql' },
  ];
  const weak: Signal[] = [
    { ev: orm?.ev, says: `uses ${orm ? ORM_NAME[orm.name] : ''}` },
    { ev: read?.ev, says: `reads ${read?.name}` },
    { ev: urlVars[0]?.ev, says: `sets ${urlVars[0]?.name}` },
  ];
  const sure = strong.some((s) => s.ev);
  if (!sure && !weak.some((s) => s.ev)) return null;
  // Only a hint of SQL, and compose runs MySQL/Mongo next to it: not Postgres.
  if (!sure && imageMatch(c.compose, OTHER_DB_IMAGE)) return null;
  const env = names([...c.reads.filter((r) => PG_URL_VAR.test(r.name)), ...urlVars]);
  const release = migrateCommand(c);
  const v = env[0] ?? 'DATABASE_URL';
  return {
    id: 'postgres',
    kind: 'postgres',
    name: 'db',
    maps: 'resources.db',
    label: 'Postgres',
    why: `A managed Postgres 16, backed up nightly. ${v} is filled in at deploy${release ? `; ${release.cmd} runs before each release` : ''}.`,
    ...found(c.dir, [...strong, ...weak, { ev: release?.ev, says: 'migrates' }]),
    env: env.length ? env : ['DATABASE_URL'],
    ...(release ? { release: release.cmd } : {}),
  };
}

function migrateCommand(c: ScanCtx): { cmd: string; ev?: Evidence } | null {
  const proc = c.procfile.find((p) => p.name === 'release');
  if (proc) return { cmd: proc.value, ev: proc.ev };
  const script = c.scripts.find((s) => /^(db:)?migrate(:deploy|:prod)?$|^prisma:migrate$/.test(s.name));
  if (script) return { cmd: c.run(script.name), ev: script.ev };
  if (c.has('manage.py')) return { cmd: 'python manage.py migrate' };
  if (c.has('alembic.ini')) return { cmd: 'alembic upgrade head' };
  const rails = c.dep('rails');
  if (rails) return { cmd: 'bundle exec rails db:migrate', ev: rails.ev };
  return null;
}

const REDIS_DEPS = ['ioredis', 'redis', '@redis/client', 'github.com/redis/go-redis/v9', 'github.com/go-redis/redis/v8', 'predis/predis'];
const QUEUE_DEPS = ['bullmq', 'bull', 'bee-queue', 'sidekiq', 'rq', 'celery', 'dramatiq'];
const QUEUE_NAME: Record<string, string> = { bullmq: 'BullMQ', bull: 'Bull', 'bee-queue': 'Bee-Queue', sidekiq: 'Sidekiq', rq: 'RQ', celery: 'Celery', dramatiq: 'Dramatiq' };
const REDIS_VAR = /^(REDIS|VALKEY|CACHE|QUEUE|BULL|BULLMQ)(_[A-Z0-9]+)*_(URL|HOST|PORT)$|^REDIS_TLS_URL$/;
const REDIS_IMAGE = /^(redis|valkey\/valkey|redis\/redis-stack[\w-]*|bitnami\/(redis|valkey)|eqalpha\/keydb|docker\.dragonflydb\.io\/dragonflydb\/dragonfly)(:|@|$)/;

export function detectCache(c: ScanCtx): Detection | null {
  const queue = c.dep(...QUEUE_DEPS);
  const driver = c.dep(...REDIS_DEPS);
  const image = imageMatch(c.compose, REDIS_IMAGE);
  const vars = [...c.dotenv.filter((e) => REDIS_VAR.test(e.name)), ...c.reads.filter((r) => REDIS_VAR.test(r.name))];
  // createClient / new Worker( are generic names — they only count next to a Redis client library.
  const code = c.grep(driver || queue ? /(new Redis\(|new (?:Queue|Worker)\(|createClient\()/ : /(new Redis\()/)[0];
  if (!queue && !driver && !vars.length && !code && !image) return null;
  const env = names(vars);
  const kind = queue ? 'queue' : 'cache';
  const v = env[0] ?? 'REDIS_URL';
  const varSays = vars[0] ? `${c.dotenv.includes(vars[0]) ? 'sets' : 'reads'} ${vars[0].name}` : '';
  return {
    id: kind,
    kind,
    name: kind,
    maps: `resources.${kind}`,
    label: queue ? `Job queue (${queue.name})` : 'Redis / Valkey cache',
    why: queue
      ? `A managed Valkey set up for queues — nothing is evicted and it is saved to disk. ${v} points at it.`
      : `A managed Valkey cache (Redis-compatible). ${v} points at it.`,
    ...found(c.dir, [
      { ev: queue?.ev, says: `uses ${queue ? QUEUE_NAME[queue.name] : ''} for jobs` },
      { ev: driver?.ev, says: `uses ${depWords(driver?.name ?? '')}` },
      { ev: code?.ev, says: 'connects to Redis' },
      { ev: image?.image?.ev, says: `runs ${image?.image?.value} as ${image?.name}` },
      { ev: vars[0]?.ev, says: varSays },
    ]),
    env: env.length ? env : ['REDIS_URL'],
  };
}
