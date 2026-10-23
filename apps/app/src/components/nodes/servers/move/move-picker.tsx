import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import { FIT_WORD } from './fit-check';
import { useMove } from './move-context';
import type { MovePlan } from './use-move-plan';

const TONE = { fits: 'ok', tight: 'warn', 'wont-fit': 'bad', unknown: 'idle' } as const;

/**
 * The keyboard path to a move (no dragging): every other server as a
 * button, with its fit and memory before → after; pick one to review.
 */
export function MovePicker({ plan }: { plan: MovePlan }): React.JSX.Element {
  const m = useMove();
  const first = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => first.current?.focus(), []);
  if (plan.block) return <p className="text-[13px] leading-relaxed">{plan.block}</p>;
  return (
    <ul aria-label="Move to" className="flex flex-col gap-1.5">
      {plan.targets.map((t, i) => {
        const tone = t.block ? 'bad' : TONE[t.fit.verdict];
        return (
          <li key={t.id}>
            <button
              ref={i === 0 ? first : undefined}
              type="button"
              disabled={!!t.block}
              onClick={() => m.choose(t.id)}
              className="border-border hover:bg-foreground/[0.04] focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 disabled:opacity-60 pointer-coarse:min-h-11"
            >
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
              <span className="text-[13.5px] font-semibold">{t.name}</span>
              <span className={cn('ml-auto text-right font-mono text-[12px]', TONE_TEXT[tone])}>
                {t.block ?? (t.fit.afterPct !== null ? `${FIT_WORD[t.fit.verdict]} · ${t.fit.beforePct}% → ${t.fit.afterPct}%` : FIT_WORD[t.fit.verdict])}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
