import * as React from 'react';
import { cn } from '@swarmy/ui';
import { diffLines, diffStats } from './line-diff';

/**
 * Inline (unified) line diff — old vs new config content. Green rows are
 * additions, crimson rows removals, gutters carry old/new line numbers.
 */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }): React.JSX.Element {
  const lines = React.useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const stats = diffStats(lines);

  if (stats.added === 0 && stats.removed === 0) {
    return (
      <p className="text-muted-foreground border-border rounded-xl border border-dashed p-4 text-center text-xs">
        No changes yet — the content matches the current version.
      </p>
    );
  }

  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div className="border-border bg-accent/40 flex items-center gap-2 border-b px-3 py-1.5">
        <span className="mono-data text-status-online text-xs font-semibold">+{stats.added}</span>
        <span className="mono-data text-status-offline text-xs font-semibold">−{stats.removed}</span>
        <span className="text-muted-foreground text-xs">lines changed</span>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {lines.map((l, i) => (
              <tr
                key={i}
                className={cn(
                  l.op === 'add' && 'bg-status-online/10',
                  l.op === 'del' && 'bg-status-offline/10',
                )}
              >
                <td className="text-muted-foreground/60 w-8 select-none pr-1 text-right align-top">
                  {l.oldLine ?? ''}
                </td>
                <td className="text-muted-foreground/60 w-8 select-none pr-2 text-right align-top">
                  {l.newLine ?? ''}
                </td>
                <td
                  className={cn(
                    'w-4 select-none text-center align-top font-semibold',
                    l.op === 'add' && 'text-status-online',
                    l.op === 'del' && 'text-status-offline',
                  )}
                >
                  {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ''}
                </td>
                <td className="whitespace-pre-wrap break-all pr-3 align-top">{l.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
