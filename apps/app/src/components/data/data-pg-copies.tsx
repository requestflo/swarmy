import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import { DataPgStrip } from './data-pg-strip';

/**
 * Board 15: where each managed database's copies run. The writer moves by
 * handing its writes to a standby copy (the planned switchover), never by
 * copying its disk; standby copies stay where they were placed.
 */
export function DataPgCopies({ rows }: { rows: ReadonlyArray<{ stack: string; cluster: string }> }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <Section
      title="Where each database’s copies run"
      count={`${rows.length} database${rows.length === 1 ? '' : 's'}`}
      hint={<Tech>db.switchover · writes pause for a few seconds, nothing is lost</Tech>}
    >
      <ul className="flex flex-col" aria-label="Databases and their copies">
        {rows.map((r) => (
          <DataPgStrip key={`${r.stack}/${r.cluster}`} stack={r.stack} cluster={r.cluster} />
        ))}
      </ul>
      <p className="text-muted-foreground font-mono text-[11px]">
        <span className="hidden pointer-fine:inline">Drag the writer onto a standby copy to make that copy the writer · </span>
        <span className="pointer-fine:hidden">Tap a standby copy to make it the writer · </span>
        standby copies stay where they were placed
      </p>
    </Section>
  );
}
