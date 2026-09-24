import * as React from 'react';
import { cn } from '@swarmy/ui';
import { cellText } from './studio-types';

interface StudioResultTableProps {
  columns: string[];
  rows: unknown[][];
  /** column → type label shown in the header. */
  types?: Record<string, string>;
  /** Key columns get a subtle marker. */
  keys?: string[];
  sort?: { col: string; dir: 'asc' | 'desc' } | null;
  onSort?: (col: string) => void;
  selected?: number | null;
  onSelect?: (index: number) => void;
  className?: string;
}

/** The studio grid: sticky typed header, mono cells, NULL distinct from ''. */
export function StudioResultTable({ columns, rows, types, keys, sort, onSort, selected, onSelect, className }: StudioResultTableProps): React.JSX.Element {
  if (columns.length === 0) {
    return <p className="text-muted-foreground px-4 py-6 text-sm">No columns — the statement returned no result set.</p>;
  }
  return (
    <div className={cn('min-h-0 overflow-auto', className)}>
      <table className="w-max min-w-full border-collapse text-left">
        <thead className="bg-muted sticky top-0 z-10">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                onClick={onSort ? () => onSort(c) : undefined}
                aria-sort={sort?.col === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                className={cn('border-border h-9 border-b px-3 text-xs font-semibold whitespace-nowrap', onSort && 'hover:text-primary cursor-pointer select-none')}
              >
                {c}
                {sort?.col === c ? <span className="text-primary ml-1">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                {keys?.includes(c) ? <span className="text-primary ml-1">●</span> : null}
                {types?.[c] ? <span className="text-muted-foreground ml-1.5 font-mono text-[10px] font-normal">{types[c]}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              onClick={onSelect ? () => onSelect(i) : undefined}
              className={cn(
                'border-border border-b transition-colors',
                onSelect && 'hover:bg-accent/60 cursor-pointer',
                selected === i && 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]',
              )}
            >
              {columns.map((c, j) => {
                const v = r[j];
                const text = cellText(v);
                return (
                  <td
                    key={c}
                    title={text.length > 60 ? text : undefined}
                    className={cn('h-8 max-w-[28rem] truncate px-3 font-mono text-xs whitespace-nowrap', (v === null || v === undefined) && 'text-muted-foreground/70')}
                  >
                    {text === '' ? <span className="text-muted-foreground/60">''</span> : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
