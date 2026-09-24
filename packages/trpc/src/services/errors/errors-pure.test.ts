/**
 * Pure pieces around ingest: SENTRY_* injection (the otel-injection
 * guarantees), issue lifecycle + spike decisions, DSN shape, the ClickHouse
 * DDL, and org-scoping of every read builder.
 */
import { describe, expect, test } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { APP_COMMIT_LABEL, APP_ENV_LABEL } from '../apps/live';
import { augmentSpecsForErrors, COMMIT_LABELS, ENV_LABELS, ERRORS_ENABLED_LABEL, injectErrors, specsRequestErrors } from './injection';
import { decideTransition, isSpike, issueResource } from './lifecycle';
import { buildDsn, takeRateLimit, resetRateLimits } from './projects';
import * as q from './query';
import { renderErrorsSchema } from './schema';
import { artifactDebugId, artifactKind } from './store';

const spec = (over: Partial<ServiceSpec> = {}): ServiceSpec =>
  ({ name: 'shop_web', image: 'web:1', mode: { replicated: { replicas: 1 } }, ...over }) as ServiceSpec;
const DSN = 'https://k@swarmy.example.com/1234567';

describe('SENTRY_* injection', () => {
  test('off is identity (clean revert)', () => {
    const specs = [spec()];
    expect(augmentSpecsForErrors(specs, { enabled: false, dsn: DSN })).toBe(specs);
    expect(augmentSpecsForErrors(specs, { enabled: true, dsn: null })).toBe(specs);
  });
  test('fills DSN, release from the commit label, environment; stamps the label', () => {
    const out = injectErrors(spec({ labels: { [APP_COMMIT_LABEL]: 'abc1234', [APP_ENV_LABEL]: 'staging' } }), { dsn: DSN });
    expect(out.env).toEqual({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'staging', SENTRY_RELEASE: 'abc1234' });
    expect(out.labels?.[ERRORS_ENABLED_LABEL]).toBe('true');
    expect(out.image).toBe('web:1');
  });
  test('never overwrites user-set SENTRY_* values', () => {
    const out = injectErrors(spec({ env: { SENTRY_DSN: 'https://mine@sentry.io/1', SENTRY_RELEASE: 'v9' } }), { dsn: DSN });
    expect(out.env?.SENTRY_DSN).toBe('https://mine@sentry.io/1');
    expect(out.env?.SENTRY_RELEASE).toBe('v9');
  });
  test('a service labelled false opts out; the label in any spec opts the deploy in', () => {
    const specs = [spec({ labels: { [ERRORS_ENABLED_LABEL]: 'true' } }), spec({ name: 'shop_worker', labels: { [ERRORS_ENABLED_LABEL]: 'false' } })];
    expect(specsRequestErrors(specs)).toBe(true);
    const out = augmentSpecsForErrors(specs, { enabled: true, dsn: DSN });
    expect(out[0]!.env?.SENTRY_DSN).toBe(DSN);
    expect(out[1]).toBe(specs[1]);
  });
  test('label names stay in step with the git-apps compiler', () => {
    expect(COMMIT_LABELS[0]).toBe(APP_COMMIT_LABEL);
    expect(ENV_LABELS[0]).toBe(APP_ENV_LABEL);
  });
});

describe('lifecycle', () => {
  const t0 = Date.parse('2026-09-24T10:00:00Z');
  test('new, regression after resolve, stragglers before it', () => {
    expect(decideTransition(null, { release: '', timestamp: t0 }).kind).toBe('new');
    const resolved = { status: 'resolved' as const, status_changed_at: '2026-09-24 10:00:00.000', resolved_in_release: '' };
    expect(decideTransition(resolved, { release: '', timestamp: t0 + 1000 }).kind).toBe('regression');
    expect(decideTransition(resolved, { release: '', timestamp: t0 - 1000 }).kind).toBe('none');
  });
  test('resolve in next release: same release is fine, a new one regresses', () => {
    const next = { status: 'resolved_next_release' as const, status_changed_at: '2026-09-24 10:00:00.000', resolved_in_release: 'aaa' };
    expect(decideTransition(next, { release: 'aaa', timestamp: t0 + 1 }).kind).toBe('none');
    expect(decideTransition(next, { release: '', timestamp: t0 + 1 }).kind).toBe('none');
    expect(decideTransition(next, { release: 'bbb', timestamp: t0 + 1 }).kind).toBe('regression');
  });
  test('ignored and unresolved never transition', () => {
    for (const status of ['ignored', 'unresolved'] as const) {
      expect(decideTransition({ status, status_changed_at: '', resolved_in_release: '' }, { release: 'x', timestamp: t0 }).kind).toBe('none');
    }
  });
  test('spikes', () => {
    expect(isSpike(19, 0)).toBe(false); // below the floor
    expect(isSpike(20, 0)).toBe(true); // brand-new and loud
    expect(isSpike(50, 144 * 20)).toBe(false); // 20/window baseline → 50 is 2.5×
    expect(isSpike(100, 144 * 20)).toBe(true); // 5×
    expect(issueResource('shop', '8cce9dff0a60bc844663ffca12c43a18')).toBe('errors:shop:8cce9dff0a60');
  });
});

describe('projects', () => {
  test('DSN shape (SDKs derive /api/<id>/envelope/ from it)', () => {
    expect(buildDsn('https://swarmy.example.com', 'abc', 1234567)).toBe('https://abc@swarmy.example.com/1234567');
    expect(buildDsn('https://example.com/swarmy/', 'abc', 7)).toBe('https://abc@example.com/swarmy/7');
    expect(buildDsn('http://localhost:3021', 'abc', 7)).toBe('http://abc@localhost:3021/7');
  });
  test('rate limit: fixed one-minute windows', () => {
    resetRateLimits();
    const t = 1_000_000;
    expect(takeRateLimit(1, 2, t)).toBe(0);
    expect(takeRateLimit(1, 2, t + 1)).toBe(0);
    expect(takeRateLimit(1, 2, t + 30_000)).toBe(30);
    expect(takeRateLimit(1, 2, t + 60_000)).toBe(0);
    expect(takeRateLimit(2, 1, t, 5)).toBe(60);
  });
});

describe('artifacts', () => {
  test('kind + debug id', () => {
    expect(artifactKind('~/a.js.map', '')).toBe('sourcemap');
    expect(artifactKind('~/a.js', '{"version":3,"mappings":"AAAA"}')).toBe('sourcemap');
    expect(artifactKind('~/a.js', 'function a(){}')).toBe('minified');
    expect(artifactDebugId('sourcemap', '{"version":3,"debugId":"DF7FE4DAD1F76B7464756E2164756E21"}')).toBe('df7fe4da-d1f7-6b74-6475-6e2164756e21');
    expect(artifactDebugId('minified', 'x()\n//# debugId=DF7FE4DAD1F76B7464756E2164756E21\n')).toBe('df7fe4da-d1f7-6b74-6475-6e2164756e21');
  });
});

describe('ClickHouse DDL + org scoping', () => {
  test('DDL is idempotent, TTL follows retention, database name validated', () => {
    const ddl = renderErrorsSchema({ database: 'otel', retentionDays: 14 });
    expect(ddl.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS otel.swarmy_error_'))).toHaveLength(4);
    expect(ddl[0]).toContain('INTERVAL 14 DAY');
    expect(ddl[1]).toBe('ALTER TABLE otel.swarmy_error_events MODIFY TTL toDateTime(timestamp) + INTERVAL 14 DAY');
    expect(ddl.join('\n')).toContain('ENGINE = ReplacingMergeTree(version)');
    expect(() => renderErrorsSchema({ database: 'otel; DROP', retentionDays: 7 })).toThrow();
  });

  const ORG = "org_1' OR '1'='1";
  const scoped = (sql: string, tables: number) => {
    const hits = sql.match(/org_id = 'org_1\\' OR \\'1\\'=\\'1'/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(tables);
  };
  test('every builder filters org_id on every table it reads (and escapes it)', () => {
    scoped(q.buildIssuesListQuery('otel', ORG, { projectId: 1, query: "x' OR 1=1 --" }), 2);
    scoped(q.buildIssueDetailQuery('otel', ORG, 1, 'a'.repeat(32)), 2);
    scoped(q.buildIssueStateQuery('otel', ORG, 1, ['a']), 1);
    scoped(q.buildIssueTrendQuery('otel', ORG, 1, ['a']), 1);
    scoped(q.buildIssueEventsQuery('otel', ORG, 1, 'a'), 1);
    scoped(q.buildEventPayloadQuery('otel', ORG, 1, 'a', 'b'), 1);
    scoped(q.buildIssueTagsQuery('otel', ORG, 1, 'a'), 1);
    scoped(q.buildArtifactIndexQuery('otel', ORG, 1, 'r'), 1);
    scoped(q.buildArtifactContentQuery('otel', ORG, 1, 'r', 'n'), 1);
    scoped(q.buildArtifactsByDebugIdQuery('otel', ORG, 1, ['d']), 1);
    scoped(q.buildSpikeQuery('otel', ORG), 1);
  });
  test('the issue detail narrows the list query to one fingerprint', () => {
    expect(q.buildIssueDetailQuery('otel', 'o', 1, 'f'.repeat(32))).toContain(`fingerprint = '${'f'.repeat(32)}') AS i`);
  });
  test('numbers are clamped', () => {
    expect(q.buildIssuesListQuery('otel', 'o', { projectId: 1, limit: 10_000 })).toContain('LIMIT 200');
    expect(q.buildSpikeQuery('otel', 'o', { windowMinutes: -5 })).toContain('INTERVAL 1 MINUTE');
  });
});

describe('swarmy.yaml `errors: true`', () => {
  test('parses, normalises, and the compiler stamps the opt-in label on every service', async () => {
    const { parseAppConfig, toDesired } = await import('@swarmy/app-config');
    const { compileServices } = await import('../apps/compile');
    const res = parseAppConfig(
      'version: 1\napp: shop\nerrors: true\nservices:\n  web:\n    image: nginx:1.27\n    port: 80\n  worker:\n    image: busybox:1.36\n',
    );
    const desired = toDesired(res.config!);
    expect(desired.errors).toBe(true);
    const out = compileServices(desired, { web: 'nginx:1.27', worker: 'busybox:1.36' });
    expect(out.composeSource.match(/swarmy\.errors\.enabled/g)).toHaveLength(2);
  });
  test('absent means off', async () => {
    const { parseAppConfig } = await import('@swarmy/app-config');
    const { toDesired } = await import('@swarmy/app-config');
    const res = parseAppConfig('version: 1\napp: shop\nservices:\n  web:\n    image: nginx:1.27\n');
    expect(toDesired(res.config!).errors).toBeUndefined();
  });
});
