import * as React from 'react';
import type { ConfigIssue } from '@swarmy/app-config';
import { Button, cn } from '@swarmy/ui';
import type { Fix } from './fixes';
import { CODE_LEFT, LINE_H, PAD_Y } from './yaml-lines';

/**
 * The problem on a line, pinned beside it (board: "size · use 1gb · Fix"):
 * the key it's about, the parser's own words, and Fix when the problem
 * names the answer. Lines too long to sit beside get it underneath.
 */
export function LintBubble({ issue, lineLength, fix, onFix }: { issue: ConfigIssue; lineLength: number; fix: Fix | null; onFix: (fix: Fix) => void }): React.JSX.Element | null {
  if (!issue.line) return null;
  const beside = lineLength < 46;
  const top = PAD_Y + (issue.line - (beside ? 1 : 0)) * LINE_H + (beside ? -4 : 2);
  const left = beside ? `calc(${CODE_LEFT}px + ${lineLength + 3}ch)` : `${CODE_LEFT}px`;
  const key = issue.path.at(-1);
  return (
    <div className="absolute z-[5] h-0 w-0" style={{ top, left }}>
      <div
        role="note"
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          'bg-popover text-popover-foreground absolute top-0 left-0 flex w-max max-w-[min(360px,70vw)] items-center gap-2.5 rounded-xl border px-2.5 py-1.5 font-sans text-xs shadow-lg',
          issue.severity === 'error' ? 'border-status-offline/50' : 'border-status-warning/60',
        )}
      >
        {key !== undefined ? (
          <span className={cn('shrink-0 font-mono font-semibold', issue.severity === 'error' ? 'text-tone-bad' : 'text-tone-warn')}>{String(key)}</span>
        ) : null}
        <span className="text-muted-foreground line-clamp-2">{issue.message}</span>
        {fix ? (
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => onFix(fix)} aria-label={`Fix: use ${fix.to}`}>
            Fix
          </Button>
        ) : null}
      </div>
    </div>
  );
}
