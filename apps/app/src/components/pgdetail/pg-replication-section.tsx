import * as React from 'react';
import { CalmRow, RowList, Section, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { standbyRows } from './pg-replication';
import type { PgDetailData } from './use-pg-detail';
import { standbyCopies, type PgReplicationData } from './use-pg-replication';

/**
 * How far behind each standby copy is (board 39): one row per copy, by
 * server — caught up, or how many bytes and seconds behind — with its replay
 * position at Controls. Read on the main copy (`pg_stat_replication`).
 */
export function PgReplicationSection({ d, r }: { d: PgDetailData; r: PgReplicationData }): React.JSX.Element | null {
  const c = d.cluster!;
  if (!r.wanted) return null;
  const v = r.view;
  const rows = v ? standbyRows(v.standbys, d.nodes) : [];
  const copies = standbyCopies(c);
  const missing = Math.max(0, copies - rows.length);
  return (
    <Section title="How far behind each copy is" count={v ? `${rows.length} of ${copies}` : undefined} flush>
      {r.pending ? (
        <CardSkeleton />
      ) : !v ? (
        <p className="text-muted-foreground pb-3 text-[13px]">Couldn’t ask the main copy just now: {r.error?.message ?? 'no answer'}.</p>
      ) : (
        <RowList label="Standby copies">
          {rows.map((row) => (
            <CalmRow key={row.key} tone={row.tone} name={row.name} sub={row.sub} say={row.say} tech={row.tech} word={row.word} />
          ))}
          {missing > 0 ? (
            <CalmRow
              tone="warn"
              name={`${missing} not connected`}
              say={`${missing === 1 ? 'A standby copy isn’t' : `${missing} standby copies aren’t`} streaming from the main copy right now.`}
              word="not streaming"
            />
          ) : null}
        </RowList>
      )}
      {v ? (
        <div className="pb-2.5">
          <Tech>
            pg_stat_replication on {c.primary.service} · primary at {v.primaryLsn ?? '—'} · read {new Date(v.measuredAt).toLocaleTimeString()}
          </Tech>
        </div>
      ) : null}
    </Section>
  );
}
