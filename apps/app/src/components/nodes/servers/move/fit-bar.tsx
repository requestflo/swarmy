import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import type { Fit } from './fit-check';

const ADD = { fits: 'bg-status-online', tight: 'bg-status-warning', 'wont-fit': 'bg-status-offline', unknown: 'bg-status-idle' } as const;
const WORD = { fits: 'ok', tight: 'warn', 'wont-fit': 'bad', unknown: 'idle' } as const;

/**
 * Memory before → after on one server (board 9's capacity bar): what's in
 * use now, and the slice the move adds, coloured by the verdict.
 */
export function FitBar({ server, fit }: { server: string; fit: Fit }): React.JSX.Element {
  const before = fit.beforePct;
  const after = fit.afterPct;
  const label =
    before === null ? `${server} memory: no live numbers` : after === null ? `${server} memory: ${before}% now` : `${server} memory: ${before}% now, ${after}% after`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="text-muted-foreground">{server} memory</span>
        <span className={cn('font-mono', TONE_TEXT[WORD[fit.verdict]])}>
          {before === null ? '—' : after === null ? `${before}%` : `${before}% → ${after}%`}
        </span>
      </div>
      <span role="img" aria-label={label} className="bg-foreground/[0.07] relative block h-2 overflow-hidden rounded-full">
        {before !== null ? <span className="bg-status-progress absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, before)}%` }} /> : null}
        {before !== null && after !== null ? (
          <span
            className={cn('absolute inset-y-0 opacity-80', ADD[fit.verdict])}
            style={{ left: `${Math.min(100, before)}%`, width: `${Math.max(0, Math.min(100, after) - Math.min(100, before))}%` }}
          />
        ) : null}
      </span>
    </div>
  );
}
