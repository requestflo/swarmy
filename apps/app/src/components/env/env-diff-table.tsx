import * as React from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { maskValue, type EnvDiffRow } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';

interface EnvDiffTableProps {
  rows: EnvDiffRow[];
  masked: Set<string>;
  onToggleMask: (key: string) => void;
  /** Hide unchanged rows (default true) — the preview is about what moves. */
  hideUnchanged?: boolean;
}

const KIND_STYLE: Record<EnvDiffRow['kind'], { sign: string; className: string }> = {
  added: { sign: '+', className: 'text-status-online' },
  changed: { sign: '~', className: 'text-status-warning' },
  removed: { sign: '−', className: 'text-status-offline' },
  unchanged: { sign: ' ', className: 'text-muted-foreground' },
};

/** Added / changed / removed preview; secret-looking values masked (flippable). */
export function EnvDiffTable({ rows, masked, onToggleMask, hideUnchanged = true }: EnvDiffTableProps): React.JSX.Element {
  const shown = hideUnchanged ? rows.filter((r) => r.kind !== 'unchanged') : rows;
  if (!shown.length) return <p className="text-muted-foreground text-sm">No changes yet — paste KEY=value lines above.</p>;
  const show = (key: string, v: string | undefined): string => (v === undefined ? '' : masked.has(key) ? maskValue(v) : v);

  return (
    <div className="max-h-72 overflow-auto rounded-xl border">
      <table className="w-full font-mono text-xs">
        <tbody>
          {shown.map((r) => {
            const style = KIND_STYLE[r.kind];
            return (
              <tr key={r.key} className="border-b last:border-b-0">
                <td className={cn('w-6 px-2 py-1.5 text-center font-bold', style.className)}>{style.sign}</td>
                <td className="px-2 py-1.5 font-semibold break-all">{r.key}</td>
                <td className="px-2 py-1.5 break-all">
                  {r.kind === 'changed' && (
                    <span className="text-muted-foreground line-through">{show(r.key, r.before)}</span>
                  )}
                  {r.kind === 'changed' && ' → '}
                  {r.kind === 'removed' ? (
                    <span className="text-muted-foreground line-through">{show(r.key, r.before)}</span>
                  ) : (
                    <span className="whitespace-pre-wrap">{show(r.key, r.after)}</span>
                  )}
                </td>
                <td className="w-8 px-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={masked.has(r.key) ? 'Secret — masked. Click to show.' : 'Mark as secret'}
                    onClick={() => onToggleMask(r.key)}
                  >
                    {masked.has(r.key) ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
