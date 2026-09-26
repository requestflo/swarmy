import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, TONE_TEXT } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import type { BoardRow, EnvKind } from './app-board-model';
import { plural, shortImage } from './app-words';

/** The row's sentence without the status word it already shows ("Online. All 4…" → "All 4…"). */
export function rowSay(row: BoardRow): string {
  return row.app.words.say.replace(new RegExp(`^${row.app.words.word}\\.\\s*`), '');
}

/** One pip per part: filled when all its copies run. */
function Pips({ row }: { row: BoardRow }): React.JSX.Element {
  const svcs = row.app.stat.services.slice(0, 12);
  return (
    <span aria-hidden className="flex items-center gap-[3px]">
      {svcs.map((s) => (
        <i
          key={s.id}
          className={cn(
            'h-1.5 w-2.5 shrink-0 rounded-[3px]',
            s.replicas.desired > 0 && s.replicas.running >= s.replicas.desired ? 'bg-status-online' : 'ring-border ring-[1.5px] ring-inset',
          )}
        />
      ))}
    </span>
  );
}

/** RIGHT NOW: status word + plain sentence, then parts, copies and (Controls) the image. */
export function RightNowCell({ row }: { row: BoardRow }): React.JSX.Element {
  const { words, stat } = row.app;
  const lead = stat.services[0];
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2 text-[13.5px] leading-snug">
        <span className={cn('shrink-0 font-semibold', TONE_TEXT[words.tone])}>{words.word}</span>
        <span className="text-muted-foreground line-clamp-2">{rowSay(row)}</span>
      </span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-[11px]">
        <Pips row={row} />
        <span className="truncate">
          {plural(stat.serviceCount, 'part')} · {stat.running}/{stat.desired} copies
          {lead ? <Depth at="controls"> · {shortImage(lead.image)}</Depth> : null}
        </span>
      </span>
    </span>
  );
}

const PILL: Record<EnvKind, string> = {
  production: 'bg-surface-2 text-foreground/85 dark:bg-accent',
  staging: 'bg-status-progress/15 text-tone-info',
  preview: 'bg-tone-mesh/15 text-tone-mesh',
  other: 'bg-surface-2 text-muted-foreground dark:bg-accent',
};

export function EnvPills({ row }: { row: BoardRow }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-[3px]">
      {row.pills.map((p) => (
        <span key={p.label} className={cn('inline-flex h-[22px] items-center rounded-full px-[7px] text-[11px] font-semibold whitespace-nowrap', PILL[p.kind])}>
          {p.label}
        </span>
      ))}
    </span>
  );
}

export function ServersCell({ row }: { row: BoardRow }): React.JSX.Element {
  const s = row.servers;
  if (s === undefined) return <TextSkeleton className="w-20" />;
  if (s === null) return <span className="text-muted-foreground text-xs">on no server</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-mono text-xs">{s.primary}</span>
      <span className="truncate text-xs">
        <span className="text-muted-foreground">{s.places}</span>
        {s.privateOnly ? <span className="text-tone-mesh">{s.places ? ' · ' : ''}private network</span> : null}
      </span>
    </span>
  );
}

export function DeployCell({ row }: { row: BoardRow }): React.JSX.Element {
  const d = row.deploy;
  if (d === undefined) return <TextSkeleton className="w-24" />;
  if (d === null) return <span className="text-muted-foreground text-xs">no deploys yet</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-mono text-xs">{d.version}</span>
      <span className="text-muted-foreground truncate text-xs" title={d.inFlight ? `${d.who} · ${d.inFlight}` : undefined}>
        {d.who}
        {d.inFlight ? <span className="text-tone-info font-mono text-[11px]"> · {d.inFlight}</span> : null}
      </span>
    </span>
  );
}
