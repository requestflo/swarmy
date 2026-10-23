import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { gb } from '../server-words';
import { FitBar } from './fit-bar';
import type { MoveDraft } from './move-context';
import { previewWords } from './move-words';
import type { MovePlan, TargetPlan } from './use-move-plan';

/**
 * Board 9's preview card: the verdict, a sentence title, why, memory before
 * → after on both servers, and the actions (confirm, or "release to review").
 */
export function MovePreview({
  draft,
  from,
  plan,
  target,
  children,
}: {
  draft: MoveDraft;
  from: string;
  plan: MovePlan;
  target: TargetPlan;
  children?: (go: boolean) => React.ReactNode;
}): React.JSX.Element {
  const w = previewWords({ short: draft.chip.short, from, plan, target });
  const src = target.fit.source;
  return (
    <div className="flex flex-col gap-3">
      <span className={cn('inline-flex w-fit items-center gap-1.5 text-xs font-semibold', TONE_TEXT[w.tone])}>
        <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[w.tone])} />
        {w.verdict}
      </span>
      <h3 className="font-display text-[18px] leading-tight font-bold tracking-[-0.01em]">{w.title}</h3>
      {w.body ? <p className="text-muted-foreground text-[13px] leading-relaxed">{w.body}</p> : null}
      {!plan.block && !target.block ? (
        <div className="bg-foreground/[0.04] flex flex-col gap-2.5 rounded-xl px-3 py-2.5">
          <FitBar server={target.name} fit={target.fit} />
          {src ? (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-muted-foreground">{from} memory</span>
              <span className="text-tone-ok font-mono">
                {src.beforePct}% → {src.afterPct}%
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {plan.checking ? <p className="text-muted-foreground text-[12.5px]">Checking what data {draft.chip.short} keeps…</p> : null}
      <Tech>
        {`decommission.moveService · ${draft.chip.name} → ${target.id}`}
        {plan.volumes?.length ? ` · volumes ${plan.volumes.join(', ')}` : ''}
        {plan.needBytes !== null ? ` · ${gb(plan.needBytes)} peak memory × ${plan.copies}` : ' · no usage sample yet'}
      </Tech>
      {children?.(w.go && !plan.checking)}
    </div>
  );
}
