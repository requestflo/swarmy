import * as React from 'react';
import { GlobeIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { memWords, serverNote, spreadWords, type ServerCard } from './strip-model';

const MAX_PIPS = 6;

function Pip({ mine, children }: { mine?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className={cn(
        'max-w-24 truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]',
        mine ? 'bg-surface-2 text-foreground ring-foreground/30 font-semibold ring-1 dark:bg-accent' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function ServerTile({ c, name }: { c: ServerCard; name: string }): React.JSX.Element {
  const mine = c.copies === null ? 1 : c.copies;
  const hot = c.tone === 'warn';
  return (
    <li className={cn('flex min-w-0 flex-col gap-2 rounded-xl border px-3 py-3', c.copies !== 0 ? 'border-foreground/25' : 'border-border')}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[c.tone])} />
        <span className="truncate text-[13.5px] font-semibold">{c.node.name}</span>
        {c.node.region ? <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">{c.node.region}</span> : null}
      </span>
      <span className="flex min-h-12 flex-wrap content-start gap-1">
        {Array.from({ length: Math.min(mine, MAX_PIPS) }, (_, i) => (
          <Pip key={`m${i}`} mine>{name}</Pip>
        ))}
        {mine > MAX_PIPS ? <Pip mine>+{mine - MAX_PIPS}</Pip> : null}
        {c.others.slice(0, 3).map((o) => (
          <Pip key={o}>{o}</Pip>
        ))}
        {c.others.length > 3 ? <Pip>+{c.others.length - 3}</Pip> : null}
      </span>
      <span className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="text-muted-foreground">memory</span>
        <span className={cn('ml-auto', hot ? TONE_TEXT.warn : 'text-muted-foreground')}>{memWords(c.memUsed, c.memTotal)}</span>
      </span>
      <span role="meter" aria-label={`${c.node.name} memory in use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.memPct ?? 0} className="bg-muted relative h-1.5 overflow-hidden rounded-full">
        {c.memPct !== null ? (
          <span className={cn('absolute inset-y-0 left-0 rounded-full', hot ? 'bg-status-warning' : 'bg-status-online')} style={{ width: `${Math.min(100, c.memPct)}%` }} />
        ) : null}
      </span>
      <span className="text-muted-foreground font-mono text-[11px]">{serverNote(c, name)}</span>
    </li>
  );
}

/**
 * "Where web runs" (board AppScaling): every server that's up, its memory in
 * use and the copies on it, the picked service's first.
 */
export function ServerStrip({
  name,
  desired,
  running,
  sizeLabel,
  address,
  cards,
}: {
  name: string;
  desired: number;
  running: number;
  /** "0.5 CPU · 512 MB" — omitted until the spec is read. */
  sizeLabel: string | undefined;
  address: string | null | undefined;
  cards: ServerCard[] | undefined;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="calm-card flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={id} className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
          Where {name} runs
        </h2>
        {cards ? (
          <span className="text-muted-foreground text-[12.5px]">
            {spreadWords(cards, desired, running, name)}
            {sizeLabel ? ` · ${sizeLabel} each` : ''}
          </span>
        ) : null}
        {address !== undefined ? (
          <span className="border-border text-muted-foreground ml-auto inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 font-mono text-[11.5px]">
            <GlobeIcon aria-hidden className="size-3.5" />
            {address ?? 'no address · reached inside the app'}
          </span>
        ) : null}
      </div>
      {cards ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
          {cards.map((c) => (
            <ServerTile key={c.node.id} c={c} name={name} />
          ))}
        </ul>
      ) : (
        <div aria-hidden className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer-line h-32 rounded-xl" />
          ))}
        </div>
      )}
      <Tech>placement: services.list per server · memory: nodes.list live snapshot · a count shows only when it follows from placement</Tech>
    </section>
  );
}
