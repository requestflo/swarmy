import { describe, expect, it } from 'bun:test';
import {
  buildBreakdownQuery,
  buildDeleteSessionStatements,
  buildDeleteUserStatements,
  buildOverviewQuery,
  buildReplayListQuery,
  buildReplayRequestsQuery,
  buildReplayLogsQuery,
  RUM_DDL,
} from './clickhouse';
import { deletePrefix, expiredDays, memoryBlobStore, replayChunkKey, replaySessionPrefix, signS3Request } from './blobs';

describe('clickhouse builders are org + app scoped and escape everything', () => {
  const evil = "x' OR 1=1 --";
  it('every read carries the org and app predicate', () => {
    for (const sql of [
      buildOverviewQuery('org_1', 'shop', {}),
      buildBreakdownQuery('org_1', 'shop', 'path', {}),
      buildReplayListQuery('org_1', 'shop', { withErrors: true }),
    ]) {
      expect(sql).toContain("org_id = 'org_1' AND app = 'shop'");
    }
  });
  it('quotes are escaped, numbers clamped, dimensions allowlisted', () => {
    const sql = buildReplayListQuery(evil, evil, { userId: evil, days: 99999, limit: -5 });
    expect(sql).toContain("org_id = 'x\\' OR 1=1 --'");
    expect(sql).toContain('today() - 365');
    expect(sql).toContain('LIMIT 1');
    expect(() => buildBreakdownQuery('o', 'a', 'path; DROP TABLE x' as never, {})).toThrow();
  });
  it('replay requests: only hex trace ids, org scoped, session attribute', () => {
    const sql = buildReplayRequestsQuery('org_1', 'sess123456', ['0af7651916cd43dd8448eb211c80319c', "bad'"], { fromMs: 1_000_000, toMs: 2_000_000 });
    expect(sql).toContain("ResourceAttributes['swarmy.org_id'] = 'org_1'");
    expect(sql).toContain("TraceId IN ('0af7651916cd43dd8448eb211c80319c')");
    expect(sql).not.toContain("bad'");
    expect(sql).toContain("SpanAttributes['swarmy.session_id'] = 'sess123456'");
    expect(buildReplayLogsQuery('org_1', [], { fromMs: 0, toMs: 1 })).toBe('');
  });
  it('GDPR deletes hit both tables, scoped', () => {
    const s = buildDeleteSessionStatements('org_1', 'shop', 'abc');
    expect(s).toHaveLength(2);
    expect(s.every((q) => q.includes("org_id = 'org_1' AND app = 'shop' AND session_id = 'abc'"))).toBe(true);
    const u = buildDeleteUserStatements('org_1', null, 'u1');
    expect(u.every((q) => q.includes("org_id = 'org_1' AND user_id = 'u1'"))).toBe(true);
  });
  it('tables carry a per-row TTL (retention per app)', () => {
    expect(RUM_DDL.every((d) => /TTL toDateTime\((ts|start_ts)\) \+ toIntervalDay\(retention_days\)/.test(d))).toBe(true);
  });
});

describe('replay blobs', () => {
  it('keys are day-partitioned and path-safe', () => {
    expect(replayChunkKey('org_1', 'shop', '2026-09-24', 'abc123defg', 7)).toBe('rum/org_1/shop/2026-09-24/abc123defg/000007.json.gz');
    expect(replaySessionPrefix('o/../x', 'a b', '2026-09-24', 's')).toBe('rum/o%2f..%2fx/a%20b/2026-09-24/s/');
  });
  it('expired days are strictly older than retention', () => {
    const now = new Date('2026-09-24T10:00:00Z');
    expect(expiredDays(['2026-09-01', '2026-09-10', '2026-09-11', '2026-09-24', 'junk'], 14, now)).toEqual(['2026-09-01']);
  });
  it('deletePrefix removes only that session', async () => {
    const s = memoryBlobStore();
    await s.put(replayChunkKey('o', 'a', '2026-09-24', 's1aaaaaaaa', 0), new Uint8Array([1]));
    await s.put(replayChunkKey('o', 'a', '2026-09-24', 's1aaaaaaaa', 1), new Uint8Array([1]));
    await s.put(replayChunkKey('o', 'a', '2026-09-24', 's2aaaaaaaa', 0), new Uint8Array([1]));
    expect(await deletePrefix(s, replaySessionPrefix('o', 'a', '2026-09-24', 's1aaaaaaaa'))).toBe(2);
    expect([...s.objects.keys()]).toEqual(['rum/o/a/2026-09-24/s2aaaaaaaa/000000.json.gz']);
    expect((await s.list('rum/o/a/', '/')).prefixes).toEqual(['rum/o/a/2026-09-24/']);
  });
  it('SigV4 signing is deterministic and scoped to the region', () => {
    const c = { endpoint: 'http://swarmy-garage:3900', region: 'garage', bucket: 'swarmy-rum-replays', accessKeyId: 'GK1', secretAccessKey: 'sk' };
    const at = new Date('2026-09-24T12:00:00Z');
    const a = signS3Request(c, { method: 'GET', key: 'rum/o/a b.json' }, at);
    const b = signS3Request(c, { method: 'GET', key: 'rum/o/a b.json' }, at);
    expect(a).toEqual(b);
    expect(a.url).toBe('http://swarmy-garage:3900/swarmy-rum-replays/rum/o/a%20b.json');
    expect(a.headers.authorization).toContain('Credential=GK1/20260924/garage/s3/aws4_request');
    expect(a.headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });
});
