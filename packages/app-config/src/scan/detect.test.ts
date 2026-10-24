import { describe, expect, it } from 'bun:test';
import { detectAppNeeds } from './detect';
import { scanFile, scanHits } from './files';
import type { Detection, ScanFile } from './types';

const files = (m: Record<string, string>): ScanFile[] => Object.entries(m).map(([p, t]) => scanFile(p, t));
const find = (ds: Detection[], id: string): Detection | undefined => ds.find((d) => d.id === id);

const PKG = `{
  "name": "orders",
  "scripts": {
    "start": "node dist/server.js",
    "worker": "node dist/worker.js",
    "migrate": "node dist/migrate.js",
    "invoices:nightly": "node dist/jobs/invoices.js"
  },
  "dependencies": {
    "pg": "^8.12.0",
    "bullmq": "^5.8.0",
    "ioredis": "^5.4.1",
    "@aws-sdk/client-s3": "^3.600.0",
    "fastify": "^4.28.0"
  }
}`;
const ENV = 'DATABASE_URL=postgres://localhost:5432/orders\nREDIS_URL=redis://localhost:6379\nS3_ENDPOINT=http://localhost:9000\nS3_BUCKET=invoices\nS3_ACCESS_KEY_ID=dev\n';
const DOCKERFILE = 'FROM node:22-alpine AS deps\nRUN pnpm install\nFROM deps AS build\nRUN pnpm build\nFROM node:22-alpine AS runtime\nARG NODE_ENV=production\nARG APP_VERSION\nEXPOSE 3000\nCMD ["node", "dist/server.js"]\n';

const ORDERS = [
  ...files({
    'services/orders/package.json': PKG,
    'services/orders/.env.example': ENV,
    'services/orders/Dockerfile': DOCKERFILE,
  }),
  scanHits('services/orders/src/queue.ts', [{ line: 3, text: 'export const connection = new Redis(process.env.REDIS_URL!);' }]),
  scanHits('services/orders/src/pdf/store.ts', [{ line: 7, text: 'const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT });' }]),
];

describe('detectAppNeeds: a monorepo service (services/orders)', () => {
  const r = detectAppNeeds(ORDERS, { dir: 'services/orders', present: ['services/orders/pnpm-lock.yaml'] });

  it('finds every need, web first and required', () => {
    expect(r.detections.map((d) => d.id)).toEqual(['web', 'worker:worker', 'postgres', 'queue', 'bucket', 'cron:invoices']);
    expect(r.detections[0]).toMatchObject({ kind: 'web', required: true, port: 3000, maps: 'services.web' });
    expect(r.files).toBe(5);
  });

  it('records file:line evidence for each', () => {
    expect(find(r.detections, 'web')!.evidence).toContainEqual({ file: 'services/orders/Dockerfile', line: 8, text: 'EXPOSE 3000' });
    expect(find(r.detections, 'postgres')!.evidence[0]).toEqual({ file: 'services/orders/package.json', line: 10, text: '"pg": "^8.12.0",' });
    expect(find(r.detections, 'queue')!.evidence.map((e) => `${e.file}:${e.line}`)).toEqual([
      'services/orders/package.json:11',
      'services/orders/package.json:12',
      'services/orders/src/queue.ts:3',
      'services/orders/.env.example:2',
    ]);
    expect(find(r.detections, 'bucket')!.evidence.map((e) => `${e.file}:${e.line}`)).toContain('services/orders/src/pdf/store.ts:7');
    expect(find(r.detections, 'cron:invoices')!.evidence[0]).toMatchObject({ file: 'services/orders/package.json', line: 7 });
  });

  it('maps each to its swarmy.yaml key, with the env vars the app reads', () => {
    expect(find(r.detections, 'postgres')).toMatchObject({ name: 'db', maps: 'resources.db', env: ['DATABASE_URL'], release: 'pnpm run migrate' });
    expect(find(r.detections, 'queue')).toMatchObject({ kind: 'queue', maps: 'resources.queue', env: ['REDIS_URL'] });
    // The bucket is named after S3_BUCKET; keys never become the app's own vars.
    expect(find(r.detections, 'bucket')).toMatchObject({ name: 'invoices', maps: 'resources.invoices', env: ['S3_ENDPOINT', 'S3_BUCKET'] });
    expect(find(r.detections, 'worker:worker')).toMatchObject({ maps: 'services.worker', command: 'pnpm run worker' });
    expect(find(r.detections, 'cron:invoices')).toMatchObject({ via: 'script', schedule: '0 2 * * *', maps: 'jobs.invoices', command: 'pnpm run invoices:nightly' });
  });

  it('reads build facts from the Dockerfile', () => {
    expect(r.build).toEqual({
      dockerfile: 'services/orders/Dockerfile',
      stages: ['deps', 'build', 'runtime'],
      args: [{ name: 'NODE_ENV', default: 'production' }, { name: 'APP_VERSION' }],
    });
  });
});

describe('detectAppNeeds: Postgres', () => {
  it('prisma → postgres via the schema provider, binding every env("…") url', () => {
    const r = detectAppNeeds(
      files({
        'package.json': '{ "dependencies": { "@prisma/client": "5.0.0" } }',
        'prisma/schema.prisma': 'datasource db {\n  provider  = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n',
      }),
    );
    const pg = find(r.detections, 'postgres')!;
    expect(pg.evidence[0]).toEqual({ file: 'prisma/schema.prisma', line: 2, text: 'provider = "postgresql"' });
    expect(pg.env).toEqual(['DATABASE_URL', 'DIRECT_URL']);
  });

  it('a MySQL repo is not Postgres', () => {
    const r = detectAppNeeds(files({ 'package.json': '{ "dependencies": { "prisma": "5" } }', 'prisma/schema.prisma': 'provider = "mysql"\n' }));
    expect(find(r.detections, 'postgres')).toBeUndefined();
    const env = detectAppNeeds(files({ '.env.example': 'DATABASE_URL=mysql://root@localhost/app\n', 'requirements.txt': 'sqlalchemy\n' }));
    expect(find(env.detections, 'postgres')).toBeUndefined();
  });

  it('Python: psycopg in requirements.txt, Django migrations as the release', () => {
    const r = detectAppNeeds(files({ 'requirements.txt': 'django>=5\npsycopg[binary]==3.2.1\ngunicorn\n' }), { present: ['manage.py'] });
    expect(find(r.detections, 'postgres')).toMatchObject({ release: 'python manage.py migrate', evidence: [{ file: 'requirements.txt', line: 2 }] });
  });
});

describe('detectAppNeeds: cache, queue, bucket', () => {
  it('ioredis alone is a cache; REDIS_HOST is bound as a host', () => {
    const r = detectAppNeeds([
      ...files({ 'package.json': '{"dependencies": {"ioredis": "5"}}', '.env.example': 'REDIS_HOST=localhost\n' }),
      scanHits('src/cache.ts', [{ line: 2, text: 'const redis = new Redis({ host: process.env.REDIS_HOST });' }]),
    ]);
    expect(find(r.detections, 'cache')).toMatchObject({ name: 'cache', env: ['REDIS_HOST'], evidence: [{ file: 'package.json', line: 1 }, { file: 'src/cache.ts', line: 2 }, { file: '.env.example', line: 1 }] });
  });

  it('boto3 + S3_* env → a bucket named "files" when no bucket name is given', () => {
    const r = detectAppNeeds(files({ 'requirements.txt': 'boto3==1.34\n', '.env.example': 'S3_REGION=eu-west-1\n' }));
    expect(find(r.detections, 'bucket')).toMatchObject({ name: 'files', env: ['S3_REGION'], evidence: [{ file: 'requirements.txt', line: 1 }, { file: '.env.example', line: 1 }] });
  });

  it('a generic createClient( without a Redis library is not a cache', () => {
    const r = detectAppNeeds([scanHits('src/db.ts', [{ line: 1, text: "const sb = createClient(url, key)" }])]);
    expect(r.detections.map((d) => d.kind)).toEqual(['web']);
  });
});

describe('detectAppNeeds: workers, cron, ports', () => {
  it('Procfile worker + clock, vercel crons, an in-process scheduler', () => {
    const r = detectAppNeeds([
      ...files({
        Procfile: 'web: gunicorn app:app --bind 0.0.0.0:8000\nworker: celery -A app worker\nclock: python clock.py\n',
        'vercel.json': '{\n  "crons": [\n    { "path": "/api/cron/cleanup", "schedule": "0 3 * * *" }\n  ]\n}\n',
        'package.json': '{ "dependencies": { "node-cron": "^3.0.3" } }',
      }),
      scanHits('src/jobs.ts', [{ line: 4, text: "cron.schedule('*/15 * * * *', syncStock);" }]),
    ]);
    expect(find(r.detections, 'web')).toMatchObject({ port: 8000, evidence: [{ file: 'Procfile', line: 1 }] });
    expect(find(r.detections, 'worker:worker')).toMatchObject({ command: 'celery -A app worker', evidence: [{ file: 'Procfile', line: 2 }] });
    expect(find(r.detections, 'cron:clock')).toMatchObject({ via: 'clock', maps: 'services.clock', evidence: [{ file: 'Procfile', line: 3 }] });
    expect(find(r.detections, 'cron:cleanup')).toMatchObject({ via: 'http', path: '/api/cron/cleanup', schedule: '0 3 * * *', evidence: [{ file: 'vercel.json', line: 3 }] });
    expect(find(r.detections, 'cron:in-process')).toMatchObject({ host: 'web', schedule: '*/15 * * * *', maps: 'services.web.replicas', evidence: [{ file: 'package.json', line: 1 }, { file: 'src/jobs.ts', line: 4 }] });
  });

  it('port from listen(), else the framework default with its dependency as evidence', () => {
    const listen = detectAppNeeds([scanHits('src/server.ts', [{ line: 9, text: 'app.listen(process.env.PORT || 8080)' }])]);
    expect(find(listen.detections, 'web')).toMatchObject({ port: 8080, evidence: [{ file: 'src/server.ts', line: 9 }] });
    const fw = detectAppNeeds(files({ 'package.json': '{\n  "dependencies": {\n    "next": "15.0.0"\n  }\n}' }), { framework: { name: 'Next.js', port: 3000, healthPath: '/', dep: 'next' } });
    expect(find(fw.detections, 'web')).toMatchObject({ port: 3000, healthPath: '/', evidence: [{ file: 'package.json', line: 3 }] });
  });
});
