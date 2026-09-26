import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { TrafficNowView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import type { RowGroup } from './app-board-model';
import { AppBoardRow, BOARD_COLS } from './app-board-row';

const HEAD = ['', 'App', 'Right now', 'Environments', 'Servers', 'Last deploy', 'Traffic · 6 h', ''];

/**
 * The apps as one table-like list (hairline rows, never per-row cards). Wide
 * containers get the board's columns; narrow ones (phones, the Code aside)
 * stack each row, so there's never a horizontal scroll.
 */
export function AppsTable({
  groups,
  labelled,
  traffic,
  q,
  onClear,
}: {
  groups: RowGroup[];
  labelled: boolean;
  traffic: TrafficNowView | undefined;
  q: string;
  onClear: () => void;
}): React.JSX.Element {
  const firstFix = groups.flatMap((g) => g.rows).find((r) => r.fix && r.fix.putBack);
  return (
    <section aria-label="Your apps" className="calm-card @container overflow-hidden">
      <div aria-hidden className={cn('border-border hidden h-8 items-center gap-x-3.5 border-b px-[18px] @4xl:grid', BOARD_COLS)}>
        {HEAD.map((h, i) => (
          <span key={i} className="calm-eyebrow text-[10.5px]">
            {h}
          </span>
        ))}
      </div>
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label || 'Apps'}>
          {labelled ? (
            <div className="border-border bg-background flex h-[30px] items-center gap-2.5 border-b px-4 @4xl:px-[18px]">
              <span className="calm-eyebrow text-foreground/75">{g.label}</span>
              <span className="text-muted-foreground font-mono text-[11px]">
                {g.rows.length} app{g.rows.length === 1 ? '' : 's'}
              </span>
              <span className="text-muted-foreground truncate text-xs">{g.hint}</span>
            </div>
          ) : null}
          {g.rows.map((r) => (
            <AppBoardRow key={r.app.name} row={r} traffic={traffic} primary={r === firstFix} />
          ))}
        </div>
      ))}
      {groups.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-4 pt-6 pb-6 @4xl:pl-[46px]">
          <span className="text-[14.5px] font-semibold">
            {q.trim() ? `Nothing matches “${q.trim()}”.` : 'No app is in that state right now.'}
          </span>
          <span className="text-muted-foreground text-[13px]">
            Search looks at app names, addresses and servers. Staging and previews show under Group · Environment.
          </span>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={onClear} className="pointer-coarse:min-h-11">
              Clear search and filters
            </Button>
            <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
              <Link to="/deploy">Deploy an app</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
