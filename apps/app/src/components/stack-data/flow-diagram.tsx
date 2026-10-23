import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/calm';

/** One box of a topology diagram: a member on a server. */
export interface FlowBox {
  key: string;
  title: string;
  /** The role word in the chip ("main copy" / "primary"). */
  chip?: string;
  chipTone?: Tone;
  meta?: string;
  stat?: string;
  statTone?: Tone;
  tone: Tone;
  /** Not there today: what the picked shape would add or remove. */
  ghost?: boolean;
}

/** A line between boxes in adjacent columns. */
export interface FlowLink {
  from: string;
  to: string;
  label?: string;
  tone: Tone;
  dashed?: boolean;
}

const BOX = 72;
const GAP = 12;
const LINK_W = 104;
const STROKE: Record<Tone, string> = {
  ok: 'var(--tone-ok)', warn: 'var(--tone-warn)', bad: 'var(--tone-bad)', info: 'var(--tone-info)', mesh: 'var(--tone-mesh)', idle: 'var(--tone-idle)',
};

const colHeight = (n: number): number => n * BOX + Math.max(0, n - 1) * GAP;

function Box({ b }: { b: FlowBox }): React.JSX.Element {
  return (
    <div className={cn('bg-card flex h-[72px] min-w-0 flex-col justify-center gap-0.5 rounded-xl border px-3', b.ghost && 'border-dashed opacity-60')}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[b.tone])} />
        <b className="truncate text-[13.5px] font-semibold">{b.title}</b>
        {b.chip ? (
          <span className={cn('bg-muted ml-auto shrink-0 rounded-full px-2 py-px text-[11px] font-semibold', b.chipTone ? TONE_TEXT[b.chipTone] : 'text-muted-foreground')}>
            {b.chip}
          </span>
        ) : null}
      </span>
      {b.meta ? <span className="text-muted-foreground truncate font-mono text-[10.5px]">{b.meta}</span> : null}
      {b.stat ? <span className={cn('truncate font-mono text-[10.5px]', b.statTone ? TONE_TEXT[b.statTone] : 'text-muted-foreground')}>{b.stat}</span> : null}
    </div>
  );
}

function Links({ left, right, links, height }: { left: FlowBox[]; right: FlowBox[]; links: FlowLink[]; height: number }): React.JSX.Element {
  const y = (col: FlowBox[], key: string): number => {
    const i = col.findIndex((b) => b.key === key);
    return (height - colHeight(col.length)) / 2 + i * (BOX + GAP) + BOX / 2;
  };
  const here = links.filter((l) => left.some((b) => b.key === l.from) && right.some((b) => b.key === l.to));
  const mid = LINK_W / 2;
  return (
    <svg width={LINK_W} height={height} className="shrink-0 overflow-visible" aria-hidden>
      {here.map((l) => {
        const y1 = y(left, l.from);
        const y2 = y(right, l.to);
        return (
          <g key={`${l.from}>${l.to}`}>
            <path d={`M0 ${y1} C ${mid} ${y1} ${mid} ${y2} ${LINK_W} ${y2}`} fill="none" strokeWidth={1.5} strokeDasharray={l.dashed ? '4 4' : undefined} style={{ stroke: STROKE[l.tone], opacity: 0.7 }} />
            {l.label ? (
              <text x={mid} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-muted-foreground font-mono" style={{ fontSize: 10 }}>
                {l.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A topology as columns of boxes joined by lines (who copies from whom). Wide
 * containers draw it left to right; narrow ones (a phone, the lg two-column
 * squeeze) stack the columns with the line's label between them.
 */
export function FlowDiagram({ columns, links, label }: { columns: FlowBox[][]; links: FlowLink[]; label: string }): React.JSX.Element {
  const shown = columns.filter((c) => c.length > 0);
  const height = Math.max(...shown.map((c) => colHeight(c.length)), BOX);
  const labelInto = (col: FlowBox[]): string | undefined => links.find((l) => col.some((b) => b.key === l.to) && l.label)?.label;
  return (
    <div role="group" aria-label={label} className="@container">
      <div className="hidden items-center @[34rem]:flex" style={{ height }}>
        {shown.map((col, ci) => (
          <React.Fragment key={col[0]!.key}>
            {ci > 0 ? <Links left={shown[ci - 1]!} right={col} links={links} height={height} /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {col.map((b) => <Box key={b.key} b={b} />)}
            </div>
          </React.Fragment>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 @[34rem]:hidden">
        {shown.map((col, ci) => (
          <React.Fragment key={col[0]!.key}>
            {ci > 0 ? (
              <span className="text-muted-foreground pl-4 font-mono text-[10.5px]">↓ {labelInto(col) ?? ''}</span>
            ) : null}
            <div className="grid gap-2 @[24rem]:grid-cols-2">
              {col.map((b) => <Box key={b.key} b={b} />)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
