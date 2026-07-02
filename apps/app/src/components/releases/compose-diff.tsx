import * as React from 'react';
import type { ComposeDiffLine } from '@swarmy/core';
import { cn } from '@swarmy/ui';

/**
 * Compose diff viewer: the release's compose vs the previous deploy, line by
 * line. Additions wash green, deletions crimson — status tokens, never raw
 * palette.
 */
export function ComposeDiff({ diff }: { diff: ComposeDiffLine[] }): React.JSX.Element {
  if (diff.length === 0) {
    return <p className="text-muted-foreground px-4 py-6 text-sm">Empty compose file.</p>;
  }
  const changed = diff.some((l) => l.kind !== 'same');
  return (
    <div className="max-h-80 overflow-auto rounded-xl border">
      {!changed ? (
        <p className="text-muted-foreground border-b px-4 py-2 text-xs">
          Identical to the previous release.
        </p>
      ) : null}
      <pre className="font-mono text-xs leading-5">
        {diff.map((l, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2 px-2',
              l.kind === 'add' && 'bg-status-online/12 text-status-online',
              l.kind === 'del' && 'bg-status-offline/12 text-status-offline',
            )}
          >
            <span className="text-muted-foreground/60 w-8 shrink-0 select-none text-right">
              {l.kind === 'del' ? l.aLine : l.bLine}
            </span>
            <span className="w-3 shrink-0 select-none">
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </span>
            <span className="whitespace-pre-wrap break-all">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
