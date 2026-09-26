import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { TrafficNowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import type { BoardRow } from './app-board-model';
import { AppFix } from './app-fix';
import { DeployCell, EnvPills, RightNowCell, ServersCell, rowSay } from './app-row-cells';
import { TrafficCell } from './app-traffic';

/** The board's column template (wide container only). */
export const BOARD_COLS =
  '@4xl:grid-cols-[14px_minmax(150px,190px)_minmax(0,1fr)_124px_136px_136px_112px_14px]';

function Dot({ row }: { row: BoardRow }): React.JSX.Element {
  const tone = row.app.words.tone;
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone], row.fix && 'animate-pulse motion-reduce:animate-none', tone === 'idle' && 'opacity-60')}
    />
  );
}

/** Phone and narrow columns: name + status word + sentence, then a small facts line. */
function StackedBody({ row, traffic }: { row: BoardRow; traffic: TrafficNowView | undefined }): React.JSX.Element {
  const { words, stat, hosts } = row.app;
  const facts = [
    hosts[0],
    `${stat.running}/${stat.desired} copies`,
    row.servers ? row.servers.primary : null,
    row.deploy ? row.deploy.version : null,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-2.5">
        <Dot row={row} />
        <span className="truncate text-[14.5px] font-semibold">{row.app.name}</span>
        <span className={cn('ml-auto shrink-0 text-xs font-semibold', TONE_TEXT[words.tone])}>{words.word}</span>
      </span>
      <span className="text-muted-foreground pl-[18px] text-[13px] leading-snug">{rowSay(row)}</span>
      <span className="text-muted-foreground pl-[18px] font-mono text-[11px] leading-relaxed break-words">
        {facts.join(' · ')}
        {hosts.length ? (
          <>
            {' · '}
            <TrafficCell app={row.app.name} hasAddress now={traffic} warn={!!row.fix} compact />
          </>
        ) : null}
      </span>
    </span>
  );
}

export function AppBoardRow({
  row,
  traffic,
  primary,
}: {
  row: BoardRow;
  traffic: TrafficNowView | undefined;
  /** This row carries the page's one coral action. */
  primary: boolean;
}): React.JSX.Element {
  const { name, hosts, words } = row.app;
  const env = row.env === 'production' ? '' : ` ${row.env}`;
  return (
    <div className={cn('border-border border-b last:border-b-0', row.fix && 'bg-status-warning/[0.06]')}>
      <Link
        to="/stacks/$name"
        params={{ name }}
        aria-label={`Open ${name}${env}: ${words.word}`}
        className={cn(
          'group flex min-h-[58px] items-center gap-x-3.5 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 @4xl:grid @4xl:px-[18px]',
          BOARD_COLS,
          row.fix ? 'hover:bg-status-warning/[0.04]' : 'hover:bg-foreground/[0.025]',
        )}
      >
        <span className="contents @max-4xl:hidden">
          <Dot row={row} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[14.5px] font-semibold">{name}</span>
            <span className="text-muted-foreground truncate font-mono text-[11.5px]">{hosts[0] ?? 'no address yet'}</span>
          </span>
          <RightNowCell row={row} />
          <EnvPills row={row} />
          <ServersCell row={row} />
          <DeployCell row={row} />
          <TrafficCell app={name} hasAddress={hosts.length > 0} now={traffic} warn={!!row.fix} />
        </span>
        <span className="flex min-w-0 flex-1 @4xl:hidden">
          <StackedBody row={row} traffic={traffic} />
        </span>
        <ChevronRightIcon
          aria-hidden
          className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
        />
      </Link>
      <AppFix row={row} primary={primary} />
    </div>
  );
}
