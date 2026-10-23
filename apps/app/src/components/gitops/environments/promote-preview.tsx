import * as React from 'react';
import { CircleAlertIcon, EqualIcon, PlusIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, Tech, type Tone } from '@/components/calm';
import type { Gate, PlanActionView } from '../gitops-types';
import { imageRef, type ImageChange } from './lanes-model';

const GATE: Record<Gate, { Icon: typeof PlusIcon; tone: Tone; label: string }> = {
  auto: { Icon: PlusIcon, tone: 'ok', label: 'runs on its own' },
  confirm: { Icon: CircleAlertIcon, tone: 'warn', label: 'needs you' },
  blocked: { Icon: XIcon, tone: 'bad', label: 'blocked' },
};

/** "All gates clear · 2 digests change" · "1 blocked · 1 needs you". */
export function gateLine(counts: Record<Gate, number>, changes: number): { text: string; tone: Tone } {
  if (counts.blocked > 0 || counts.confirm > 0) {
    const parts = [counts.blocked ? `${counts.blocked} blocked` : null, counts.confirm ? `${counts.confirm} ${counts.confirm === 1 ? 'needs' : 'need'} you` : null];
    return { text: parts.filter(Boolean).join(' · '), tone: counts.blocked ? 'bad' : 'warn' };
  }
  return { text: `All gates clear · ${changes} ${changes === 1 ? 'digest changes' : 'digests change'}`, tone: 'ok' };
}

/** Before Apply: the exact digests that move, what stays, and every step of the plan with its gate. */
export function PromotePreview({
  changes,
  same,
  actions,
}: {
  changes: ImageChange[];
  same: string[];
  actions: PlanActionView[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Images" className="border-border flex flex-col divide-y rounded-xl border">
        {changes.map((c) => (
          <li key={c.name} className="flex items-baseline gap-2 px-3 py-2 font-mono text-[12px]">
            <span className="text-tone-info w-3 font-bold">~</span>
            <span className="font-semibold">{c.name}</span>
            <span className="text-muted-foreground truncate">
              {c.from ? imageRef(c.from) : 'not running'} → <span className="text-foreground">{imageRef(c.to)}</span>
            </span>
          </li>
        ))}
        {same.map((n) => (
          <li key={n} className="text-muted-foreground flex items-baseline gap-2 px-3 py-2 font-mono text-[12px]">
            <EqualIcon aria-hidden className="size-3" />
            <span>{n}</span>
            <span>same digest on both</span>
          </li>
        ))}
        {changes.length + same.length === 0 ? <li className="text-muted-foreground px-3 py-2 text-[13px]">No built images to move — production keeps what it runs.</li> : null}
      </ul>
      {actions.length > 0 ? (
        <ul aria-label="Plan" className="flex flex-col gap-2">
          {actions.map((a) => {
            const g = GATE[a.gate];
            return (
              <li key={a.id} className="flex items-start gap-2.5 text-[13px]">
                <g.Icon aria-label={g.label} className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT[g.tone])} />
                <span className="min-w-0 flex-1">
                  {a.reason}
                  <span className="block">
                    <Tech>{a.id}</Tech>
                  </span>
                </span>
                {a.gate !== 'auto' ? <span className={cn('shrink-0 text-xs font-semibold', TONE_TEXT[g.tone])}>{g.label}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
