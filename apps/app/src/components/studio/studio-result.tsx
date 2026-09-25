import * as React from 'react';
import { DownloadIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { StudioResultTable } from './studio-result-table';
import { download, toCsv, toJson } from './studio-export';
import type { StudioRunView } from './studio-types';

/** A console / saved-query result: meta line, grid, CSV/JSON export of exactly what came back. */
export function StudioResult({ result, name }: { result: StudioRunView; name: string }): React.JSX.Element {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${name}-${stamp}`;
  const meta = [
    `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`,
    result.affected != null ? `${result.affected} affected` : null,
    result.status ?? null,
    `${result.durationMs} ms`,
    result.classification.class === 'read' ? 'read-only' : result.classification.class,
    result.truncated ? 'cut at the row / size limit' : null,
  ].filter(Boolean);
  return (
    <div className="calm-card shadow-none flex min-h-0 flex-col overflow-hidden border-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground font-mono text-xs">{meta.join(' · ')}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" disabled={result.columns.length === 0} onClick={() => download(`${base}.csv`, toCsv(result.columns, result.rows), 'text/csv')}>
          <DownloadIcon className="size-3.5" /> CSV
        </Button>
        <Button size="sm" variant="ghost" onClick={() => download(`${base}.json`, toJson(result.columns, result.rows, result.documents ?? undefined), 'application/json')}>
          <DownloadIcon className="size-3.5" /> JSON
        </Button>
      </div>
      {result.notices.length > 0 ? (
        <div className="text-status-warning border-border border-b px-3 py-1.5 font-mono text-xs">{result.notices.join(' · ')}</div>
      ) : null}
      <StudioResultTable columns={result.columns} rows={result.rows} className="max-h-[28rem]" />
    </div>
  );
}
