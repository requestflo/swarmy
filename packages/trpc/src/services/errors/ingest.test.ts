/**
 * The ingest pipeline end to end on a real @sentry/node envelope: DSN auth,
 * rate limiting, source-map symbolication from "uploaded" artifacts,
 * grouping, the ClickHouse rows written, and the new-issue alert. The store
 * is an in-memory fake (the `store` seam); `fireEvent` is captured (`fire`).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hashToken } from '@swarmy/core/crypto';
import { ingest } from './ingest';
import { invalidateProjectCache, resetRateLimits } from './projects';

const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
const fired: Record<string, unknown>[] = [];
let issueState: Record<string, unknown>[] = [];
const fixture = (n: string) => readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), 'utf8');
const artifacts: Record<string, string> = {
  '~/out/checkout.min.js': fixture('checkout.min.js'),
  '~/out/checkout.min.js.map': fixture('checkout.min.js.map'),
};

const fakeStore = async () => ({
  database: 'otel',
  retentionDays: 7,
  exec: async () => undefined,
  insert: async (table: string, rows: object[]) => {
    inserts.push({ table, rows: rows as Record<string, unknown>[] });
  },
  query: async <T,>(sql: string): Promise<T[]> => {
    if (sql.includes('swarmy_error_artifacts') && sql.startsWith('SELECT release, name')) {
      return Object.keys(artifacts).map((name) => ({
        release: '',
        name,
        debug_id: '',
        kind: name.endsWith('.map') ? 'sourcemap' : 'minified',
        size: 1,
        uploaded_at: '2026-09-24 00:00:00.000',
      })) as T[];
    }
    if (sql.startsWith('SELECT content')) {
      const name = /name = '([^']+)'/.exec(sql)?.[1] ?? '';
      return (artifacts[name] ? [{ content: artifacts[name] }] : []) as T[];
    }
    if (sql.includes('swarmy_error_issues')) return issueState as T[];
    return [];
  },
});
const fire = async (_ctx: unknown, input: Record<string, unknown>) => {
  fired.push(input);
};


const KEY = '0123456789abcdef0123456789abcdef';
const project = { orgId: 'org_1', stack: 'shop', projectId: 42, keyHash: hashToken(KEY), rateLimitPerMinute: 600 };
const db = {
  errorProject: {
    findUnique: async ({ where }: { where: { projectId: number } }) => (where.projectId === 42 ? project : null),
  },
} as never;
const deps = { db, contextFor: (orgId: string) => ({ activeOrgId: orgId }) as never, store: fakeStore as never, fire: fire as never };
const envelope = new Uint8Array(readFileSync(new URL('./__fixtures__/node-exception-minified.envelope', import.meta.url)));
const query = new URLSearchParams(`sentry_version=7&sentry_key=${KEY}&sentry_client=sentry.javascript.node%2F11.0.0`);

beforeEach(() => {
  inserts.length = 0;
  fired.length = 0;
  issueState = [];
  invalidateProjectCache();
  resetRateLimits();
  project.rateLimitPerMinute = 600;
});

describe('ingest', () => {
  test('accepts the real envelope, symbolicates, groups, stores and alerts', async () => {
    const res = await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query });
    expect(res).toEqual({ status: 200, body: { id: 'a85a275618b544019a81c3173ff1e148' } });

    const events = inserts.find((i) => i.table === 'swarmy_error_events')!.rows;
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.org_id).toBe('org_1');
    expect(ev.project_id).toBe(42);
    // Grouped on the ORIGINAL names (golden in grouping.test.ts).
    expect(ev.fingerprint).toBe('8cce9dff0a60bc844663ffca12c43a18');
    expect(ev.trace_id).toBe('e6d9a2c48eeb47b48f0f04df754d5bbc');
    expect(ev.release).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    expect(ev.user_key).toBe('id:u-42');
    expect(ev.culprit).toBe('priceOf(src/checkout.js)');
    const payload = JSON.parse(String(ev.payload));
    const top = payload.exception.values[0].stacktrace.frames.at(-1);
    expect(top.function).toBe('priceOf');
    expect(top.data.minified.function).toBe('n');

    const issues = inserts.find((i) => i.table === 'swarmy_error_issues')!.rows;
    expect(issues[0]).toMatchObject({ status: 'unresolved', first_release: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', title: 'TypeError: Cannot read price of broken' });
    expect(inserts.find((i) => i.table === 'swarmy_error_releases')).toBeDefined();
    await Bun.sleep(0);
    expect(fired).toEqual([
      expect.objectContaining({ signal: 'error-new-issue', severity: 'warning', resource: 'errors:shop:8cce9dff0a60' }),
    ]);
  });

  test('a resolved issue seen again is a regression', async () => {
    issueState = [
      {
        fingerprint: '8cce9dff0a60bc844663ffca12c43a18',
        status: 'resolved',
        status_changed_at: '2020-01-01 00:00:00.000',
        resolved_in_release: '',
        first_seen: '2020-01-01 00:00:00.000',
        first_release: 'old',
      },
    ];
    await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query });
    await Bun.sleep(0);
    expect(fired[0]).toMatchObject({ signal: 'error-regression', severity: 'critical' });
    expect(inserts.find((i) => i.table === 'swarmy_error_issues')!.rows[0]).toMatchObject({ status: 'unresolved', first_release: 'old' });
  });

  test('an ignored issue stores the event but writes no state and raises nothing', async () => {
    issueState = [{ fingerprint: '8cce9dff0a60bc844663ffca12c43a18', status: 'ignored', status_changed_at: '', resolved_in_release: '', first_seen: '', first_release: '' }];
    await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query });
    expect(inserts.find((i) => i.table === 'swarmy_error_events')).toBeDefined();
    expect(inserts.find((i) => i.table === 'swarmy_error_issues')).toBeUndefined();
    expect(fired).toHaveLength(0);
  });

  test('auth: missing key 401, wrong key / unknown project 403', async () => {
    expect((await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope })).status).toBe(401);
    const bad = new URLSearchParams('sentry_key=nope');
    expect((await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query: bad })).status).toBe(403);
    expect((await ingest(deps, { projectId: '43', kind: 'envelope', body: envelope, query })).status).toBe(403);
    expect((await ingest(deps, { projectId: 'abc', kind: 'envelope', body: envelope, query })).status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  test('X-Sentry-Auth header works too; malformed body is 400', async () => {
    const res = await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, authHeader: `Sentry sentry_key=${KEY}, sentry_version=7` });
    expect(res.status).toBe(200);
    const bad = await ingest(deps, { projectId: '42', kind: 'envelope', body: new TextEncoder().encode('garbage'), query });
    expect(bad.status).toBe(400);
  });

  test('sessions/spans are accepted and dropped (no retry, no rows)', async () => {
    const session = new Uint8Array(readFileSync(new URL('./__fixtures__/node-session.envelope', import.meta.url)));
    const res = await ingest(deps, { projectId: '42', kind: 'envelope', body: session, query });
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(0);
  });

  test('gzip envelopes', async () => {
    const gz = new Uint8Array(readFileSync(new URL('./__fixtures__/node-large.envelope.gz', import.meta.url)));
    const res = await ingest(deps, { projectId: '42', kind: 'envelope', body: gz, contentEncoding: 'gzip', query });
    expect(res.status).toBe(200);
    expect(inserts.find((i) => i.table === 'swarmy_error_events')!.rows[0]!.exc_type).toBe('RangeError');
  });

  test('legacy /store/ endpoint', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ event_id: 'fc6d8c0c43fc4630ad850ee518f1b9d0', message: 'hello from raven', level: 'info' }));
    const res = await ingest(deps, { projectId: '42', kind: 'store', body, query });
    expect(res).toEqual({ status: 200, body: { id: 'fc6d8c0c43fc4630ad850ee518f1b9d0' } });
  });

  test('rate limit: 429 with Retry-After and X-Sentry-Rate-Limits', async () => {
    project.rateLimitPerMinute = 1;
    expect((await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query })).status).toBe(200);
    const limited = await ingest(deps, { projectId: '42', kind: 'envelope', body: envelope, query });
    expect(limited.status).toBe(429);
    expect(limited.headers?.['Retry-After']).toMatch(/^\d+$/);
    expect(limited.headers?.['X-Sentry-Rate-Limits']).toMatch(/^\d+::key$/);
  });
});
