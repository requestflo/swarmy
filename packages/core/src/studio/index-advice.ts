import type { ForeignKeyStat, IndexFacts, IndexStat, TableStat } from './index-facts';

/**
 * Index suggestions (studio, board 63) from {@link IndexFacts}. PURE — the
 * rules are unit-tested in index-advice.test.ts. swarmy never runs these:
 * each tip is SQL to copy, with the reason in plain words.
 *
 *   fk-unindexed  a foreign key whose columns don't lead any index, on a
 *                 table of 1,000+ rows: deleting or changing the row it
 *                 points at makes Postgres read the whole table to check.
 *   seq-scans     a table of 10,000+ rows read start to finish more often
 *                 than through an index (50+ times, 10,000+ rows a time).
 *                 The column isn't in the statistics, so the SQL is a
 *                 template to fill in.
 *   unused-index  an index (1 MB+) that enforces nothing and was used for
 *                 none of its table's 1,000+ reads. Standby copies keep their
 *                 own counts, which this read doesn't see.
 */

export const ADVICE = { fkMinRows: 1_000, scanMinRows: 10_000, scanMinScans: 50, scanMinRowsPerScan: 10_000, unusedMinBytes: 1024 * 1024, unusedMinTableReads: 1_000, perKind: 5 } as const;

export type IndexTipKind = 'fk-unindexed' | 'seq-scans' | 'unused-index';

export interface IndexTip {
  kind: IndexTipKind;
  table: string;
  head: string;
  /** What doing it buys, in a few words. */
  gain: string;
  why: string;
  /** Text to copy; swarmy never runs it. */
  sql: string;
  /** `template`: fill in the column first. */
  sqlKind: 'ready' | 'template';
  /** Numbers for the tech line. */
  facts: string;
}

const count = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : Math.round(v).toLocaleString('en-US'));
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

/** Does an index lead with exactly these columns (in any order among themselves)? */
export function indexCovers(index: readonly number[], keys: readonly number[]): boolean {
  if (keys.length === 0 || index.length < keys.length) return false;
  const lead = new Set(index.slice(0, keys.length));
  return keys.every((k) => k !== 0 && lead.has(k));
}

function fkTip(f: ForeignKeyStat): IndexTip {
  const cols = f.columns.join(', ');
  return {
    kind: 'fk-unindexed',
    table: f.table,
    head: `Index ${f.table}.${f.columns.join('+')}`,
    gain: `checks and joins on ${f.references} stop reading all ${count(f.live)} rows`,
    why: `${f.table}.${cols} points at ${f.references}, but no index starts with it. Deleting or changing a row of ${f.references} makes Postgres read the whole of ${f.table} to check, and joins on it scan too.`,
    sql: `CREATE INDEX CONCURRENTLY ON ${f.table} (${cols});`,
    sqlKind: 'ready',
    facts: `foreign key ${f.name} · ${count(f.live)} rows · no non-partial index leads with (${cols})`,
  };
}

function scanTip(t: TableStat): IndexTip {
  const perScan = t.seqRead / t.seqScan;
  return {
    kind: 'seq-scans',
    table: t.table,
    head: `${t.table} is read start to finish`,
    gain: `about ${count(perScan)} rows read each time, ${count(t.seqScan)} times`,
    why: `${t.table} has ${count(t.live)} rows and was read start to finish ${count(t.seqScan)} times, but through an index only ${count(t.idxScan)}. An index on the column its queries filter by lets Postgres go straight to the rows: the slow queries above show which.`,
    sql: `CREATE INDEX CONCURRENTLY ON ${t.table} (/* the column its queries filter by */);`,
    sqlKind: 'template',
    facts: `seq_scan ${t.seqScan} · seq_tup_read ${t.seqRead} · idx_scan ${t.idxScan} · n_live_tup ${t.live} · ${size(t.bytes)}`,
  };
}

function unusedTip(x: IndexStat, reads: number, since: string, standbys: boolean): IndexTip {
  return {
    kind: 'unused-index',
    table: x.table,
    head: `${x.index} isn’t used`,
    gain: `${size(x.bytes)} back, and one less index to update on every write`,
    why: `${x.table} was read ${count(reads)} times ${since} and ${x.index} helped with none of them, yet every insert and update still writes to it.${standbys ? ' Standby copies keep their own counts: if your app reads from a standby, check there before dropping it.' : ''}`,
    sql: `DROP INDEX CONCURRENTLY ${x.index};`,
    sqlKind: 'ready',
    facts: `idx_scan 0 · ${size(x.bytes)} · enforces no constraint · table reads ${reads}`,
  };
}

export function indexAdvice(facts: IndexFacts, opts: { standbys?: boolean } = {}): IndexTip[] {
  const byTable = new Map(facts.tables.map((t) => [t.table, t]));
  const fks = facts.foreignKeys
    .filter((f) => f.keys.length > 0 && f.live >= ADVICE.fkMinRows && !f.indexes.some((ix) => indexCovers(ix, f.keys)))
    .sort((a, b) => b.live - a.live)
    .slice(0, ADVICE.perKind)
    .map(fkTip);
  const scans = facts.tables
    .filter((t) => t.live >= ADVICE.scanMinRows && t.seqScan >= ADVICE.scanMinScans && t.seqScan > t.idxScan && t.seqRead / t.seqScan >= ADVICE.scanMinRowsPerScan)
    .sort((a, b) => b.seqRead - a.seqRead)
    .slice(0, ADVICE.perKind)
    .map(scanTip);
  const since = facts.statsReset ? `since the statistics were reset on ${facts.statsReset.slice(0, 10)}` : 'since its statistics began';
  const unused = facts.indexes
    .flatMap((x) => {
      const t = byTable.get(x.table);
      const reads = t ? t.seqScan + t.idxScan : 0;
      return x.scans === 0 && !x.enforces && x.bytes >= ADVICE.unusedMinBytes && reads >= ADVICE.unusedMinTableReads ? [{ x, reads }] : [];
    })
    .sort((a, b) => b.x.bytes - a.x.bytes)
    .slice(0, ADVICE.perKind)
    .map(({ x, reads }) => unusedTip(x, reads, since, opts.standbys === true));
  return [...fks, ...scans, ...unused];
}
