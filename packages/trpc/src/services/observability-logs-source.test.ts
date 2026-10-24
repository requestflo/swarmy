import { describe, expect, it } from 'bun:test';
import { buildLogsQuery } from './observability-logs-query';

const ORG = 'org_abc123';
const FROM = Date.UTC(2026, 9, 24, 10, 0, 0);
const TO = FROM + 15 * 60 * 1000;
const SCOPE = `ResourceAttributes['swarmy.org_id'] = 'org_abc123' AND Timestamp >= fromUnixTimestamp64Milli(${FROM}) AND Timestamp <= fromUnixTimestamp64Milli(${TO})`;
const where = (sql: string) => sql.split('\n').find((l) => l.startsWith('WHERE '))!;

describe('buildLogsQuery — container output vs OTLP (never double-counted)', () => {
  it('returns each row’s source: stdout when the node agent stamped it, else otlp', () => {
    expect(buildLogsQuery(ORG, { from: FROM, to: TO })).toContain(
      "  if(ResourceAttributes['swarmy.log.source'] = 'stdout', 'stdout', 'otlp') AS source",
    );
  });

  it('auto (default) prefers OTLP per service, with the org wall inside the subquery too', () => {
    expect(where(buildLogsQuery(ORG, { from: FROM, to: TO }))).toBe(
      `WHERE ${SCOPE} AND (ResourceAttributes['swarmy.log.source'] != 'stdout' OR ResourceAttributes['swarmy.service'] NOT IN (` +
        `SELECT DISTINCT ResourceAttributes['swarmy.service'] FROM otel_logs WHERE ${SCOPE} AND ` +
        `ResourceAttributes['swarmy.log.source'] != 'stdout' AND ResourceAttributes['swarmy.service'] != ''))`,
    );
    expect(buildLogsQuery(ORG, { from: FROM, to: TO, source: 'auto' })).toBe(buildLogsQuery(ORG, { from: FROM, to: TO }));
  });

  it('stdout / otlp pick one source; all shows both', () => {
    expect(where(buildLogsQuery(ORG, { from: FROM, to: TO, source: 'stdout' }))).toBe(
      `WHERE ${SCOPE} AND ResourceAttributes['swarmy.log.source'] = 'stdout'`,
    );
    expect(where(buildLogsQuery(ORG, { from: FROM, to: TO, source: 'otlp' }))).toBe(
      `WHERE ${SCOPE} AND ResourceAttributes['swarmy.log.source'] != 'stdout'`,
    );
    expect(where(buildLogsQuery(ORG, { from: FROM, to: TO, source: 'all' }))).toBe(`WHERE ${SCOPE}`);
  });

  it('a hostile org id is escaped on both sides of the dedupe', () => {
    const sql = buildLogsQuery("o' OR '1'='1", { from: FROM, to: TO });
    expect(sql.match(/swarmy\.org_id'\] = 'o\\' OR \\'1\\'=\\'1'/g)?.length).toBe(2);
    expect(sql).not.toContain("OR '1'='1'");
  });

  it('filters still compose with the source predicate, cursor last', () => {
    const sql = where(buildLogsQuery(ORG, { from: FROM, to: TO, stack: 'shop', source: 'stdout', cursor: '42' }));
    expect(sql).toBe(
      `WHERE ${SCOPE} AND ResourceAttributes['swarmy.stack'] = 'shop' AND ResourceAttributes['swarmy.log.source'] = 'stdout' AND toUnixTimestamp64Nano(Timestamp) < 42`,
    );
  });
});
