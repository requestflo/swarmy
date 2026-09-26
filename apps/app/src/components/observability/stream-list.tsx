import * as React from 'react';
import type { LogRowView } from '@swarmy/core';
import { Button, Skeleton } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { LOGS_ROW_CAP } from './logs-shared';
import type { NavAction, StreamNav } from './stream-keys';
import { StreamLine } from './stream-line';
import { lineKey } from './stream-model';

interface StreamListProps {
  /** Oldest first, newest at the bottom (a tail). */
  rows: LogRowView[];
  nav: StreamNav;
  dispatch: React.Dispatch<NavAction>;
  fresh: number;
  capped: boolean;
  pending: boolean;
  unreachable: boolean;
  filtered: boolean;
}

/** The mono tail: newest at the bottom, sticks to the bottom while live, "N new lines" while paused. */
export function StreamList({ rows, nav, dispatch, fresh, capped, pending, unreachable, filtered }: StreamListProps): React.JSX.Element {
  const box = React.useRef<HTMLOListElement>(null);
  const stick = React.useRef(true);
  const newest = rows[rows.length - 1]?.ts_nano;

  React.useLayoutEffect(() => {
    const el = box.current;
    if (el && !nav.paused && stick.current) el.scrollTop = el.scrollHeight;
  }, [newest, nav.paused, rows.length]);

  React.useEffect(() => {
    if (!nav.cursor || !box.current) return;
    const btn = box.current.querySelector<HTMLButtonElement>(`[data-line="${CSS.escape(nav.cursor)}"]`);
    if (btn && document.activeElement !== btn) btn.focus({ preventScroll: true });
    btn?.scrollIntoView({ block: 'nearest' });
  }, [nav.cursor]);

  if (pending) {
    return <div className="flex flex-col gap-1.5 p-3">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-6 w-full rounded-md" />)}</div>;
  }
  if (unreachable) return <p className="text-muted-foreground p-4 text-[14px]">The log store isn’t answering yet. Lines show up here once it is.</p>;
  if (rows.length === 0) {
    return <p className="text-muted-foreground p-4 text-[14px]">{filtered ? 'No lines match. Clear a filter or widen the window.' : 'No lines yet. New lines appear here as they arrive.'}</p>;
  }
  const focusKey = nav.cursor && rows.some((r) => lineKey(r) === nav.cursor) ? nav.cursor : lineKey(rows[rows.length - 1]!);

  return (
    <div className="flex min-w-0 flex-col">
      {capped ? <p className="text-muted-foreground border-border/60 border-b px-3 py-1.5 text-xs">Showing the newest {LOGS_ROW_CAP}. Narrow the window or search to see older lines.</p> : null}
      <ol
        ref={box}
        aria-label="Log lines, newest at the bottom"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[max(300px,calc(100dvh-540px))] min-w-0 overflow-y-auto overscroll-contain"
      >
        {rows.map((r) => {
          const k = lineKey(r);
          return (
            <StreamLine key={k} row={r} lineKey={k} active={k === nav.cursor} tabbable={k === focusKey} open={nav.open === k} dispatch={dispatch} />
          );
        })}
      </ol>
      <div className="border-border/60 flex min-h-10 flex-wrap items-center gap-3 border-t px-3 py-1.5 text-[12.5px]">
        {nav.paused ? (
          <>
            <span className="font-semibold">{fresh === 0 ? 'Paused. No new lines yet.' : `${fresh.toLocaleString('en-GB')} new ${fresh === 1 ? 'line' : 'lines'}`}</span>
            <Button variant="outline" size="sm" className="h-8 pointer-coarse:min-h-11" onClick={() => dispatch({ kind: 'paused', paused: false })}>
              {fresh === 0 ? 'Resume' : 'Show them and resume'}
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground font-mono motion-safe:animate-pulse">waiting for the next line…</span>
        )}
        <Tech className="ml-auto">{rows.length} lines on screen</Tech>
      </div>
    </div>
  );
}
