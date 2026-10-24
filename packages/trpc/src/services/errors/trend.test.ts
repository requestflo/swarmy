/**
 * `errors.issue` carries the issue's real 24 h trend, bucketed exactly like
 * `errors.issues` — the detail chart and the list's bars read the same hours.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { OrgContext } from '../../context';
import type { OrgClickhouse } from '../observability.service';
import type { IssueListRow, IssueTrendRow } from './query';
import { trendFor } from './trend';

// A fake store only while a test sets one; every other suite gets the real module.
let fake: OrgClickhouse | null = null;
const realStore = await import('./store');
mock.module('./store', () => ({ ...realStore, errorsStore: async (ctx: OrgContext) => fake ?? realStore.errorsStore(ctx) }));
const { issueDetail, listIssues } = await import('./errors.service');

const FP = 'a'.repeat(32);
const HOUR = 3_600_000;
const chHour = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().replace('T', ' ').replace('.000Z', '');

const ISSUE: IssueListRow = {
  fingerprint: FP, title: 'TypeError: x is undefined', culprit: 'app.js in run', exc_type: 'TypeError', level: 'error',
  platform: 'javascript', status: 'unresolved', resolved_in_release: '', status_changed_at: '1970-01-01 00:00:00.000',
  status_by: '', first_seen: '2026-10-20 10:00:00.000', first_release: '', regressed_at: '1970-01-01 00:00:00.000',
  version: 1, count: 12, users: 3, last_seen: chHour(Date.now()), last_release: '', count_24h: 12,
};

function store(trendRows: IssueTrendRow[]): { ch: OrgClickhouse; sql: string[] } {
  const sql: string[] = [];
  const ch: OrgClickhouse = {
    database: 'otel',
    retentionDays: 7,
    query: async <T,>(s: string) => {
      sql.push(s);
      if (s.includes('toStartOfHour')) return trendRows as T[];
      if (s.includes('count_24h')) return [ISSUE] as T[];
      return [] as T[];
    },
    exec: async () => {},
    insert: async () => {},
  };
  return { ch, sql };
}

const ctx = {
  activeOrgId: 'org_1',
  db: {
    errorProject: {
      findUnique: async () => ({
        id: 'p1', orgId: 'org_1', stack: 'shop', projectId: 1234567, keyHash: '', keyEnc: '',
        rateLimitPerMinute: 600, rotatedAt: null, createdAt: new Date(0),
      }),
    },
  },
} as unknown as OrgContext;

afterEach(() => {
  fake = null;
});

describe('trendFor', () => {
  test('24 hourly buckets, oldest first; other issues and older hours are ignored', () => {
    const now = Date.UTC(2026, 9, 24, 12, 30);
    const rows: IssueTrendRow[] = [
      { fingerprint: FP, bucket: '2026-10-24 12:00:00', c: '5' },
      { fingerprint: FP, bucket: '2026-10-23 13:00:00', c: 2 },
      { fingerprint: FP, bucket: '2026-10-23 12:00:00', c: 9 },
      { fingerprint: 'b'.repeat(32), bucket: '2026-10-24 11:00:00', c: 7 },
    ];
    const t = trendFor(rows, FP, now);
    expect(t).toHaveLength(24);
    expect(t[0]).toBe(2);
    expect(t[23]).toBe(5);
    expect(t.reduce((a, b) => a + b, 0)).toBe(7);
  });
});

describe('errors.issue trend', () => {
  const rows: IssueTrendRow[] = [
    { fingerprint: FP, bucket: chHour(Date.now()), c: 4 },
    { fingerprint: FP, bucket: chHour(Date.now() - 3 * HOUR), c: 8 },
  ];

  test('the detail returns the real trend, not an empty array', async () => {
    const s = store(rows);
    fake = s.ch;
    const d = await issueDetail(ctx, { stack: 'shop', fingerprint: FP });
    expect(d.status).toBe('ok');
    expect(d.issue?.trend).toHaveLength(24);
    expect(d.issue?.trend[23]).toBe(4);
    expect(d.issue?.trend[20]).toBe(8);
    const trendSql = s.sql.find((q) => q.includes('toStartOfHour'));
    expect(trendSql).toContain("org_id = 'org_1' AND project_id = 1234567");
    expect(trendSql).toContain(`fingerprint IN ('${FP}')`);
  });

  test('the detail and the list bucket the same hours identically', async () => {
    fake = store(rows).ch;
    const [d, l] = await Promise.all([issueDetail(ctx, { stack: 'shop', fingerprint: FP }), listIssues(ctx, { stack: 'shop' })]);
    expect(l.issues[0]?.trend).toEqual(d.issue?.trend ?? []);
  });

  test('a quiet issue reads 24 zeros', async () => {
    fake = store([]).ch;
    const d = await issueDetail(ctx, { stack: 'shop', fingerprint: FP });
    expect(d.issue?.trend).toEqual(new Array<number>(24).fill(0));
  });
});
