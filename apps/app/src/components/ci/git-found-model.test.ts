import { describe, expect, test } from 'bun:test';
import { foundNeeds, needsHead } from './git-found-model';
import type { Detection } from './git-scan-types';

const ev = [{ file: 'package.json', line: 3, text: '"pg": "^8"' }];
const d = (x: Partial<Detection> & Pick<Detection, 'id' | 'kind' | 'name' | 'label'>): Detection => ({ maps: `resources.${x.name}`, why: '', evidence: ev, ...x });

describe('What we found · live', () => {
  test('each need: what, why in plain words, and what the swarmy.yaml adds', () => {
    const needs = foundNeeds([
      d({ id: 'web', kind: 'web', name: 'web', label: 'Web service', required: true }),
      d({ id: 'postgres', kind: 'postgres', name: 'db', label: 'Postgres', reason: 'uses Prisma with PostgreSQL in prisma/schema.prisma', env: ['DATABASE_URL', 'DIRECT_URL'] }),
      d({ id: 'cache', kind: 'cache', name: 'cache', label: 'Redis / Valkey cache' }),
      d({ id: 'bucket', kind: 'bucket', name: 'uploads', label: 'S3 object storage', reason: 'runs minio/minio as s3 in docker-compose.yml', env: ['S3_BUCKET'] }),
      d({ id: 'cron:digest', kind: 'cron', name: 'digest', label: 'Scheduled container', via: 'script', schedule: '0 7 * * 1', maps: 'jobs.digest' }),
      d({ id: 'cron:in-process', kind: 'cron', name: 'web', label: 'In-app schedule (node-cron)', via: 'in-process', host: 'web' }),
    ]);
    expect(needs.map((n) => [n.kind, n.why, n.adds])).toEqual([
      ['Postgres', 'uses Prisma with PostgreSQL in prisma/schema.prisma', 'Adds a managed Postgres, backed up nightly, connected as DATABASE_URL + DIRECT_URL'],
      // No plain-words reason (an older controller): the first line of evidence stands in.
      ['Redis / Valkey cache', 'package.json:3 "pg": "^8"', 'Adds a managed Valkey cache, connected as REDIS_URL'],
      ['S3 object storage', 'runs minio/minio as s3 in docker-compose.yml', 'Adds a private bucket, connected as S3_BUCKET; keys arrive at deploy'],
      ['Scheduled container: digest', 'package.json:3 "pg": "^8"', 'Adds a scheduled job at "0 7 * * 1"'],
      ['In-app schedule (node-cron)', 'package.json:3 "pg": "^8"', 'Keeps web at one copy, so it fires once'],
    ]);
    expect(needs[3]?.maps).toBe('jobs.digest');
  });

  test('the count reads as a sentence', () => {
    expect(needsHead(0)).toBe('Nothing else its code needs');
    expect(needsHead(1)).toBe('1 thing its code needs');
    expect(needsHead(4)).toBe('4 things its code needs');
  });
});
