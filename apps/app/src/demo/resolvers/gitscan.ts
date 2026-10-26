/**
 * Demo of "Here's what we found" (board 24): what a scan of
 * northwind/platform's services/orders finds, and `gitConnections.draftConfig`
 * for it. Shapes mirror packages/app-config/src/scan (Detection, BuildFacts)
 * and packages/trpc/src/services/git-scan.ts (AppScanView, DraftView); the
 * YAML is laid out the way `generateAppConfig` lays it out.
 */
import type { AppGraph, AppScan, BuildOptions, Detection, Draft } from '@/components/ci/git-scan-types';
import { demoFolderScan } from './gitscan-found';
import { demoHerokuScan } from './gitscan-heroku';

const D = 'services/orders';
const ev = (file: string, line: number, text: string) => ({ file: `${D}/${file}`, line, text });

const ORDERS: Detection[] = [
  { id: 'web', kind: 'web', name: 'web', maps: 'services.web', label: 'Web service', required: true, port: 3000, why: 'The app itself, built from its Dockerfile, answering on port 3000.', evidence: [ev('Dockerfile', 17, 'EXPOSE 3000'), ev('Dockerfile', 1, 'FROM node:22-alpine AS deps')] },
  { id: 'worker:worker', kind: 'worker', name: 'worker', maps: 'services.worker', label: 'Background worker', reason: 'has the script worker in package.json', command: 'pnpm run worker', why: 'Runs "pnpm run worker" from the same build, with no address — it only does work in the background.', evidence: [ev('package.json', 9, '"worker": "node dist/worker.js",'), ev('src/queue/worker.ts', 6, "export const worker = new Worker('invoices', render, { connection });")] },
  { id: 'postgres', kind: 'postgres', name: 'db', maps: 'resources.db', label: 'Postgres', reason: 'uses the pg driver in package.json', env: ['DATABASE_URL'], release: 'pnpm run migrate', why: 'A managed Postgres 16, backed up nightly. DATABASE_URL is filled in at deploy; pnpm run migrate runs before each release.', evidence: [ev('package.json', 21, '"pg": "^8.12.0",'), ev('.env.example', 1, 'DATABASE_URL=postgres://orders:orders@localhost:5432/orders'), ev('package.json', 8, '"migrate": "node dist/migrate.js",')] },
  { id: 'queue', kind: 'queue', name: 'queue', maps: 'resources.queue', label: 'Job queue (bullmq)', reason: 'uses BullMQ for jobs in package.json', env: ['REDIS_URL'], why: 'A managed Valkey set up for queues — nothing is evicted and it is saved to disk. REDIS_URL points at it.', evidence: [ev('package.json', 19, '"bullmq": "^5.8.0",'), ev('package.json', 22, '"ioredis": "^5.4.1",'), ev('src/queue.ts', 3, 'export const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });'), ev('.env.example', 2, 'REDIS_URL=redis://localhost:6379')] },
  { id: 'bucket', kind: 'bucket', name: 'invoices', maps: 'resources.invoices', label: 'S3 object storage', reason: 'uses the AWS S3 SDK (@aws-sdk/client-s3) in package.json', env: ['S3_ENDPOINT', 'S3_BUCKET'], why: 'A private bucket on your own object storage. Its address and keys arrive at deploy — the secret key as a file, never in git.', evidence: [ev('package.json', 18, '"@aws-sdk/client-s3": "^3.600.0",'), ev('src/pdf/store.ts', 7, 'const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true });'), ev('.env.example', 4, 'S3_BUCKET=invoices')] },
  { id: 'cron:invoices', kind: 'cron', name: 'invoices', maps: 'jobs.invoices', label: 'Scheduled script', reason: 'has the script invoices:nightly in package.json', via: 'script', schedule: '0 2 * * *', command: 'pnpm run invoices:nightly', why: 'Runs pnpm run invoices:nightly at "0 2 * * *" (nightly) — change the time in jobs:.', evidence: [ev('package.json', 11, '"invoices:nightly": "node dist/jobs/invoices.js",')] },
];

/** The scan for a linked folder, when the demo has one. */
export function demoScan(fullName: string, configPath: string): AppScan | undefined {
  // A Heroku app at the root: "Looks like a Heroku app", drafted by the importer.
  if (fullName.endsWith('/shop-classic') && configPath === 'swarmy.yaml') return demoHerokuScan();
  if (!fullName.endsWith('/platform') || configPath !== `${D}/swarmy.yaml`) return demoFolderScan(fullName, configPath);
  return {
    dir: D,
    app: 'orders',
    files: 11,
    ms: 1840,
    detections: ORDERS,
    build: { dockerfile: `${D}/Dockerfile`, stages: ['deps', 'build', 'runtime'], args: [{ name: 'NODE_ENV', default: 'production' }, { name: 'APP_VERSION' }] },
  };
}

const sortBy = <T extends { name: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.name < b.name ? -1 : 1));

function buildLines(dir: string, b: BuildOptions): string[] {
  const path = b.path || dir || '.';
  const extra = [
    ...(b.dockerfile ? [`      dockerfile: ${b.dockerfile}`] : []),
    ...(b.target ? [`      target: ${b.target}`] : []),
    ...(b.args && Object.keys(b.args).length ? ['      args:', ...Object.entries(b.args).map(([k, v]) => `        ${k}: ${v}`)] : []),
    ...(b.watch?.length ? ['      watch:', ...b.watch.map((w) => `        - ${w}`)] : []),
  ];
  return extra.length ? ['    build:', `      path: ${path}`, ...extra] : [`    build: ${path}`];
}

export function demoDraft(input: { app: string; dir: string; detections: Detection[]; selected: string[]; build?: BuildOptions }): Draft {
  const on = input.detections.filter((d) => d.required || input.selected.includes(d.id));
  const of = (k: Detection['kind']) => on.filter((d) => d.kind === k);
  const web = of('web')[0];
  const db = of('postgres')[0];
  const queue = [...of('queue'), ...of('cache')];
  const bucket = of('bucket')[0];
  const workers = of('worker');
  const jobs = of('cron').filter((c) => c.via === 'script');
  const build = buildLines(input.dir, input.build ?? {});
  const env = [
    ...(db?.env ?? []).map((v) => `  ${v}: \${{ ${db!.name}.url }}`),
    ...queue.flatMap((q) => (q.env ?? []).map((v) => `  ${v}: \${{ ${q.name}.url }}`)),
    ...(bucket ? [...(bucket.env ?? []).map((v) => `  ${v}: \${{ ${bucket.name}.${/BUCKET/.test(v) ? 'bucket' : 'endpoint'} }}`), `  S3_ACCESS_KEY_ID: \${{ ${bucket.name}.access_key_id }}`, `  S3_SECRET_ACCESS_KEY_FILE: \${{ ${bucket.name}.secret_access_key_file }}`] : []),
  ];
  const lines = [
    `# Generated by swarmy from ${input.dir || 'the repo root'} — review it, then commit it.`,
    '# Connections are filled in at deploy: no hosts, passwords or keys live in git.',
    '',
    'version: 1',
    `app: ${input.app}`,
    ...(env.length ? ['env:', ...env] : []),
    'services:',
    '  web:',
    ...build,
    ...(web?.port ? [`    port: ${web.port}`] : []),
    ...(db?.release ? [`    release: ${db.release}`] : []),
    ...workers.flatMap((w) => [`  ${w.name}:`, ...build, `    command: ${w.command}`]),
    ...(db || queue.length || bucket ? ['resources:'] : []),
    ...(db ? [`  ${db.name}:`, '    type: postgres', '    version: 16'] : []),
    ...queue.flatMap((q) => (q.kind === 'queue' ? [`  ${q.name}:`, '    type: queue'] : [`  ${q.name}:`, '    type: cache', '    engine: valkey'])),
    ...(bucket ? [`  ${bucket.name}:`, '    type: bucket', '    access: internal'] : []),
    ...(jobs.length ? ['jobs:', ...jobs.flatMap((j) => [`  ${j.name}:`, `    schedule: ${j.schedule}`, `    service: ${workers[0]?.name ?? 'web'}`, `    run: ${j.command}`])] : []),
  ];
  const path = input.build?.path || input.dir || '.';
  // The one parser error the advanced form can cause (schema relPath).
  if (/^\/|(^|\/)\.\.(\/|$)/.test(path)) {
    const line = lines.indexOf(build[0]!) + 1 + (build.length > 1 ? 1 : 0);
    const issues = [{ severity: 'error' as const, message: 'a path relative to the repo root (no leading / or ..)', line }];
    return { yaml: `${lines.join('\n')}\n`, valid: false, issues, notes: [], graph: null };
  }
  const wires = sortBy([db, ...queue, bucket].filter((d): d is Detection => Boolean(d))).map((d) => d.name);
  const graph: AppGraph = {
    stack: input.app,
    services: sortBy([{ name: 'web', meta: `build · ${web?.port ? `:${web.port}` : 'no address'} · 1 copy`, wires }, ...workers.map((w) => ({ name: w.name, meta: 'build · no address · 1 copy', wires }))]),
    data: sortBy([
      ...(db ? [{ name: db.name, meta: 'postgres 16 · backed up daily' }] : []),
      ...queue.map((q) => ({ name: q.name, meta: q.kind === 'queue' ? 'valkey queue · 256 MB' : 'valkey · 256 MB' })),
      ...(bucket ? [{ name: bucket.name, meta: 'bucket · internal' }] : []),
    ]),
    jobs: jobs.map((j) => ({ name: j.name, meta: `${j.schedule} · in ${workers[0]?.name ?? 'web'}` })),
  };
  return { yaml: `${lines.join('\n')}\n`, valid: true, issues: [], notes: [], graph };
}
