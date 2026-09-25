import * as React from 'react';
import { CalmRow, RowList, Section, usePageDepth } from '@/components/calm';
import type { StudioSchemaView, StudioTableView, StudioTargetView } from './studio-types';

const fmt = (n: number | null | undefined): string => (typeof n === 'number' ? n.toLocaleString() : '—');

/**
 * Summary depth of the studio: the app's databases and the chosen one's
 * tables as plain rows. Opening a table takes this page to Controls, where
 * the grid, console and slow queries live.
 */
export function StudioSummary({
  targets,
  current,
  onPick,
  schema,
  onTable,
}: {
  targets: StudioTargetView[];
  current: StudioTargetView;
  onPick: (name: string) => void;
  schema: StudioSchemaView | undefined;
  onTable: (t: StudioTableView) => void;
}): React.JSX.Element {
  const { setDepth } = usePageDepth();
  const tables = schema?.tables ?? [];
  const open = (t: StudioTableView): void => {
    onTable(t);
    setDepth('controls');
  };
  return (
    <div className="flex flex-col gap-5">
      {targets.length > 1 ? (
        <Section title="Databases" count={targets.length} flush>
          <RowList label="Databases">
            {targets.map((t) => (
              <CalmRow
                key={t.name}
                tone={t.name === current.name ? 'info' : t.unavailable || !t.running ? 'idle' : 'ok'}
                name={t.name}
                sub={`${t.engine}${t.kind === 'managed' ? ' · managed' : ''}`}
                say={t.unavailable ?? (t.running ? (t.name === current.name ? 'Showing its tables below.' : 'Show its tables.') : 'Not running.')}
                word={t.name === current.name ? 'Open' : undefined}
                wordTone="info"
                onClick={() => onPick(t.name)}
              />
            ))}
          </RowList>
        </Section>
      ) : null}
      {tables.length > 0 ? (
        <Section title={current.engine === 'mongo' ? 'Collections' : 'Tables'} count={tables.length} hint={schema?.database ?? undefined} flush>
          <RowList label="Tables">
            {tables.map((t) => (
              <CalmRow
                key={`${t.schema ?? ''}.${t.name}`}
                tone="idle"
                name={t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name}
                sub={`${t.columns.length} columns`}
                say={`About ${fmt(t.rowsEstimate)} rows.`}
                word="Browse →"
                wordTone="info"
                onClick={() => open(t)}
              />
            ))}
          </RowList>
        </Section>
      ) : null}
    </div>
  );
}
