/**
 * Data the app needs: Postgres, a Redis-compatible cache or BullMQ-style
 * queue, and S3 object storage. Each becomes a managed resource; the env vars
 * the app already reads are bound to it (`DATABASE_URL: ${{ db.url }}`).
 */
import { RESERVED_NAMES } from '../bindings';
import { unitNameOf } from './files';
import type { Fact, ScanCtx } from './context';
import type { Detection, Evidence } from './types';

export function uniqEvidence(evs: Array<Evidence | undefined>, max = 4): Evidence[] {
  const seen = new Set<string>();
  return evs
    .filter((e): e is Evidence => {
      if (!e || seen.has(`${e.file}:${e.line}`)) return false;
      seen.add(`${e.file}:${e.line}`);
      return true;
    })
    .slice(0, max);
}
const names = (facts: Fact[]): string[] => [...new Set(facts.map((f) => f.name))].slice(0, 6);

const PG_DRIVERS = ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'github.com/lib/pq', 'github.com/jackc/pgx/v5', 'github.com/jackc/pgx/v4'];
/** ORMs that point at "a SQL database" — Postgres on swarmy unless the repo says otherwise. */
const PG_ORMS = ['prisma', '@prisma/client', 'drizzle-orm', 'sqlalchemy', 'flask-sqlalchemy', 'sqlmodel'];
const PG_URL_VAR = /^(DATABASE|POSTGRES(QL)?|PG|DB)(_[A-Z0-9]+)*_URL$|^DIRECT_URL$/;
const NOT_PG = /^(mysql|mariadb|sqlite|file|mongodb(\+srv)?|sqlserver):/i;

export function detectPostgres(c: ScanCtx): Detection | null {
  const provider = c.find('prisma/schema.prisma', /provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/);
  const urlVars = c.dotenv.filter((e) => PG_URL_VAR.test(e.name));
  const dbConn = c.dotenv.find((e) => e.name === 'DB_CONNECTION');
  if ((provider && provider.value !== 'postgresql') || urlVars.some((e) => NOT_PG.test(e.value))) return null;
  if (dbConn && dbConn.value !== 'pgsql') return null;
  const strong = [
    c.dep(...PG_DRIVERS)?.ev,
    provider?.ev,
    c.find('drizzle.config.ts', /(dialect|driver)\s*:\s*['"](postgresql|pg)['"]/)?.ev ?? c.find('drizzle.config.js', /(dialect|driver)\s*:\s*['"](postgresql|pg)['"]/)?.ev,
    urlVars.find((e) => /^postgres(ql)?:/i.test(e.value))?.ev,
    dbConn?.ev,
    c.find('app.json', /heroku-postgresql/)?.ev,
  ];
  const weak = [c.dep(...PG_ORMS)?.ev, c.reads.find((r) => PG_URL_VAR.test(r.name))?.ev, urlVars[0]?.ev];
  if (!strong.some(Boolean) && !weak.some(Boolean)) return null;
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
    evidence: uniqEvidence([...strong, ...weak, release?.ev]),
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
const REDIS_VAR = /^(REDIS|VALKEY|CACHE|QUEUE|BULL|BULLMQ)(_[A-Z0-9]+)*_(URL|HOST|PORT)$|^REDIS_TLS_URL$/;

export function detectCache(c: ScanCtx): Detection | null {
  const queue = c.dep(...QUEUE_DEPS);
  const driver = c.dep(...REDIS_DEPS);
  const vars = [...c.dotenv.filter((e) => REDIS_VAR.test(e.name)), ...c.reads.filter((r) => REDIS_VAR.test(r.name))];
  // createClient / new Worker( are generic names — they only count next to a Redis client library.
  const code = c.grep(driver || queue ? /(new Redis\(|new (?:Queue|Worker)\(|createClient\()/ : /(new Redis\()/)[0];
  if (!queue && !driver && !vars.length && !code) return null;
  const env = names(vars);
  const kind = queue ? 'queue' : 'cache';
  const v = env[0] ?? 'REDIS_URL';
  return {
    id: kind,
    kind,
    name: kind,
    maps: `resources.${kind}`,
    label: queue ? `Job queue (${queue.name})` : 'Redis / Valkey cache',
    why: queue
      ? `A managed Valkey set up for queues — nothing is evicted and it is saved to disk. ${v} points at it.`
      : `A managed Valkey cache (Redis-compatible). ${v} points at it.`,
    evidence: uniqEvidence([queue?.ev, driver?.ev, code?.ev, vars[0]?.ev]),
    env: env.length ? env : ['REDIS_URL'],
  };
}

const S3_STRONG = ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', 'minio', 'aws-sdk-s3', 'github.com/aws/aws-sdk-go-v2/service/s3', 'github.com/minio/minio-go/v7', 'league/flysystem-aws-s3-v3'];
const S3_WEAK = ['aws-sdk', 'boto3', 'aws/aws-sdk-php'];
const S3_VAR = /^(AWS_)?S3_[A-Z0-9_]+$|_BUCKET(_NAME)?$|^AWS_ENDPOINT_URL_S3$/;

export function detectBucket(c: ScanCtx, taken: Set<string>): Detection | null {
  const strong = c.dep(...S3_STRONG);
  const weak = c.dep(...S3_WEAK);
  const vars = [...c.dotenv.filter((e) => S3_VAR.test(e.name)), ...c.reads.filter((r) => S3_VAR.test(r.name))];
  const code = c.grep(/(S3Client\(|new AWS\.S3\(|(?:client|resource)\(\s*['"]s3['"])/)[0];
  const s3Vars = vars.some((v) => /^(AWS_)?S3_/.test(v.name));
  if (!strong && !code && !(weak && vars.length) && !s3Vars) return null;
  const bucketVar = c.dotenv.find((e) => /BUCKET/.test(e.name) && e.value);
  const fromValue = bucketVar ? unitNameOf(bucketVar.value) : null;
  const name = fromValue && !taken.has(fromValue) && !(RESERVED_NAMES as readonly string[]).includes(fromValue) ? fromValue : 'files';
  // Keys are never the app's own names: swarmy injects S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY_FILE.
  const env = names(vars.filter((v) => !/(ACCESS_KEY|SECRET|_KEY_ID)/.test(v.name)));
  return {
    id: 'bucket',
    kind: 'bucket',
    name,
    maps: `resources.${name}`,
    label: 'S3 object storage',
    why: 'A private bucket on your own object storage. Its address and keys arrive at deploy — the secret key as a file, never in git.',
    evidence: uniqEvidence([strong?.ev, code?.ev, weak?.ev, bucketVar?.ev, vars[0]?.ev]),
    env: env.length ? env : ['S3_ENDPOINT', 'S3_BUCKET'],
  };
}
