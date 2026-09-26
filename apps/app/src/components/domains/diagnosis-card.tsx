import * as React from 'react';
import { LockIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { StatusWord, TONE_TEXT, Tech } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { diagnose } from './diagnosis';
import { STATE_CHIP } from './lifecycle';

const BORDER = {
  ok: 'border-status-online/40',
  warn: 'border-status-warning/50',
  bad: 'border-status-offline/50',
  info: 'border-status-progress/40',
  mesh: 'border-border',
  idle: 'border-border',
} as const;

/** What's wrong (or right) in one sentence, the plain fix, and the gate note. */
export function DiagnosisCard({ d }: { d: DomainDetail }): React.JSX.Element {
  const g = diagnose(d);
  const chip = STATE_CHIP[d.state];
  return (
    <section aria-label="Diagnosis" className={cn('calm-card flex flex-col gap-2 border px-4 py-3.5', BORDER[g.tone])}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <StatusWord tone={chip.tone} word={chip.word} className="mt-0.5" />
        <p className={cn('min-w-0 flex-1 text-[14px] font-semibold leading-snug', g.tone === 'bad' && TONE_TEXT.bad)}>{g.headline}</p>
      </div>
      {g.fix ? <p className="text-[13.5px] leading-snug">{g.fix}</p> : null}
      {d.warnings.filter((w) => w !== g.fix).map((w) => (
        <p key={w} className="text-tone-warn text-[12.5px] leading-snug">{w}</p>
      ))}
      {g.gate ? (
        <p className="text-muted-foreground flex items-start gap-1.5 font-mono text-[11.5px]">
          <LockIcon aria-hidden className="mt-0.5 size-3 shrink-0" /> {g.gate}
        </p>
      ) : null}
      <Tech>check said · {d.reason}</Tech>
    </section>
  );
}
