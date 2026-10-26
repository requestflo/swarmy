import { describe, expect, it } from 'bun:test';
import { parseAppConfig } from '../parse';
import { detectAppNeeds } from './detect';
import { scanFile, scanHits } from './files';
import { generateAppConfig } from './generate';
import type { Detection, ScanFile } from './types';

const files = (m: Record<string, string>): ScanFile[] => Object.entries(m).map(([p, t]) => scanFile(p, t));
const find = (ds: Detection[], id: string): Detection | undefined => ds.find((d) => d.id === id);
const reasons = (ds: Detection[]): Record<string, string | undefined> => Object.fromEntries(ds.filter((d) => d.kind !== 'web').map((d) => [d.id, d.reason]));

describe('"What we found": each finding says why, in plain words', () => {
  it('Prisma with PostgreSQL, BullMQ, the S3 SDK, a cadence script (inside the app folder)', () => {
    const r = detectAppNeeds(
      [
        ...files({
          'apps/shop/package.json': '{\n  "scripts": { "report:daily": "node report.js" },\n  "dependencies": { "@prisma/client": "5", "bullmq": "5", "@aws-sdk/client-s3": "3" }\n}',
          'apps/shop/prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
        }),
        scanHits('apps/shop/src/queue.ts', [{ line: 2, text: 'new Queue("mail", { connection })' }]),
      ],
      { dir: 'apps/shop' },
    );
    expect(reasons(r.detections)).toEqual({
      postgres: 'uses Prisma with PostgreSQL in prisma/schema.prisma',
      queue: 'uses BullMQ for jobs in package.json',
      bucket: 'uses the AWS S3 SDK (@aws-sdk/client-s3) in package.json',
      'cron:report': 'has the script report:daily in package.json',
    });
  });

  it('Rails: ActiveRecord pg, Sidekiq, Active Storage on S3, whenever', () => {
    const r = detectAppNeeds(
      files({
        Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'pg'\ngem 'sidekiq'\ngem 'whenever', require: false\n",
        'config/database.yml': 'default: &default\n  adapter: postgresql\n  encoding: unicode\n',
        'config/storage.yml': 'amazon:\n  service: S3\n  bucket: <%= ENV["S3_BUCKET"] %>\n',
        'config/schedule.rb': "every 1.day, at: '4:30 am' do\n  rake 'invoices:send'\nend\n",
      }),
    );
    expect(reasons(r.detections)).toEqual({
      'worker:worker': 'runs Sidekiq workers in Gemfile',
      postgres: 'uses ActiveRecord with PostgreSQL in config/database.yml',
      queue: 'uses Sidekiq for jobs in Gemfile',
      bucket: 'stores Active Storage files on S3 in config/storage.yml',
      'cron:send': 'schedules it with whenever in config/schedule.rb',
    });
    expect(find(r.detections, 'postgres')!.evidence.map((e) => `${e.file}:${e.line}`)).toEqual(['config/database.yml:2', 'Gemfile:3', 'Gemfile:2']);
    expect(find(r.detections, 'cron:send')).toMatchObject({ via: 'script', schedule: '30 4 * * *', command: 'bundle exec rake invoices:send', maps: 'jobs.send' });
  });

  it('a Rails app on MySQL is not Postgres', () => {
    const r = detectAppNeeds(files({ Gemfile: "gem 'rails'\ngem 'mysql2'\n", 'config/database.yml': 'default:\n  adapter: mysql2\n' }));
    expect(find(r.detections, 'postgres')).toBeUndefined();
  });

  it('docker-compose: postgres, redis and minio images, the app’s env, a cron label', () => {
    const compose = [
      'services:',
      '  app:',
      '    build: .',
      '    environment:',
      '      REDIS_URL: redis://cache:6379',
      '      S3_BUCKET: uploads',
      '  db:',
      '    image: postgres:16',
      '  cache:',
      '    image: redis:7-alpine',
      '  s3:',
      '    image: minio/minio:latest',
      '  digest:',
      '    image: ghcr.io/acme/digest:2',
      '    command: ["node", "digest.js"]',
      '    labels:',
      '      - "cron=0 7 * * 1"',
    ].join('\n');
    const r = detectAppNeeds(files({ 'docker-compose.yml': compose }));
    expect(reasons(r.detections)).toEqual({
      postgres: 'runs postgres:16 as db in docker-compose.yml',
      cache: 'runs redis:7-alpine as cache in docker-compose.yml',
      bucket: 'runs minio/minio:latest as s3 in docker-compose.yml',
      'cron:digest': 'labels digest cron: "0 7 * * 1" in docker-compose.yml',
    });
    expect(find(r.detections, 'cache')?.env).toEqual(['REDIS_URL']);
    expect(find(r.detections, 'bucket')).toMatchObject({ name: 'uploads', env: ['S3_BUCKET'] });
    // The generated swarmy.yaml adds each managed service, wired by binding, and runs the job in its image.
    const out = generateAppConfig(r.detections, { app: 'acme' });
    const cfg = parseAppConfig(out.yaml).config!;
    expect(cfg.resources).toEqual({ db: { type: 'postgres', version: 16 }, cache: { type: 'cache', engine: 'valkey' }, uploads: { type: 'bucket', access: 'internal' } });
    expect(cfg.env).toMatchObject({ DATABASE_URL: '${{ db.url }}', REDIS_URL: '${{ cache.url }}', S3_BUCKET: '${{ uploads.bucket }}' });
    expect(cfg.jobs?.digest).toEqual({ schedule: '0 7 * * 1', image: 'ghcr.io/acme/digest:2', run: 'node digest.js' });
  });

  it('boto3 with AWS_* settings is S3; AWS_* alone is not', () => {
    const r = detectAppNeeds(files({ 'requirements.txt': 'boto3==1.34\n', '.env.example': 'AWS_ACCESS_KEY_ID=\nAWS_REGION=eu-west-1\n' }));
    expect(find(r.detections, 'bucket')).toMatchObject({ reason: 'uses boto3 with AWS_* settings in requirements.txt', name: 'files', env: ['S3_ENDPOINT', 'S3_BUCKET'] });
    expect(find(detectAppNeeds(files({ '.env.example': 'AWS_REGION=eu-west-1\n' })).detections, 'bucket')).toBeUndefined();
  });

  it('celery beat: in compose, or a beat_schedule next to a celery worker', () => {
    const inCompose = detectAppNeeds(files({ 'compose.yaml': 'services:\n  beat:\n    build: .\n    command: celery -A shop beat -l info\n' }));
    expect(find(inCompose.detections, 'cron:beat')).toMatchObject({ via: 'clock', command: 'celery -A shop beat -l info', reason: 'runs celery beat as beat in compose.yaml' });
    const inCode = detectAppNeeds([
      ...files({ Procfile: 'web: gunicorn shop.wsgi\nworker: celery -A shop worker -c 4 -l info\n' }),
      scanHits('shop/celery.py', [{ line: 9, text: 'app.conf.beat_schedule = {' }]),
    ]);
    expect(find(inCode.detections, 'cron:beat')).toMatchObject({ via: 'clock', command: 'celery -A shop beat -l info', reason: 'defines a celery beat schedule in shop/celery.py' });
  });

  it('node-cron says what it schedules', () => {
    const r = detectAppNeeds([...files({ 'package.json': '{ "dependencies": { "node-cron": "3" } }' }), scanHits('src/jobs.ts', [{ line: 4, text: "cron.schedule('*/15 * * * *', sync)" }])]);
    expect(find(r.detections, 'cron:in-process')?.reason).toBe('schedules "*/15 * * * *" with node-cron in src/jobs.ts');
  });
});
