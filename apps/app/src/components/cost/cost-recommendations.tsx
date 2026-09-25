import * as React from 'react';
import { XIcon } from 'lucide-react';
import type { CostRecommendationView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { useDismissedRecs } from './use-dismissed-recs';

/** Worth trimming: saving and setup nudges, each dismissable (remembered in this browser). */
export function CostRecommendations({
  recommendations,
  isLoading,
}: {
  recommendations: CostRecommendationView[];
  isLoading: boolean;
}): React.JSX.Element {
  const { dismissed, dismiss, restoreAll } = useDismissedRecs();
  const visible = recommendations.filter((r) => !dismissed.has(r.id));
  const hiddenCount = recommendations.length - visible.length;
  return (
    <Section
      title="Worth trimming"
      count={visible.length || undefined}
      flush
      action={
        hiddenCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={restoreAll} className="pointer-coarse:min-h-11">
            Show {hiddenCount} dismissed
          </Button>
        ) : null
      }
    >
      {isLoading ? (
        <div aria-hidden className="shimmer-line my-3 h-10 rounded-lg" />
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          {recommendations.length === 0 ? 'Nothing to trim. Everything looks the right size.' : 'All dismissed.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {visible.map((rec) => (
            <li key={rec.id} className="border-border flex min-h-14 items-start gap-3 border-b py-2.5 last:border-b-0">
              <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', rec.savingsUsd != null ? 'bg-status-warning' : 'bg-status-progress')} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] leading-snug">{rec.message}</span>
                <Tech>{`${rec.kind} · ${rec.resource}`}</Tech>
              </span>
              {rec.savingsUsd != null ? <span className="text-tone-ok shrink-0 font-mono text-[13px] font-semibold">−${rec.savingsUsd}/mo</span> : null}
              <Button variant="ghost" size="icon" className="size-8 shrink-0 pointer-coarse:size-11" onClick={() => dismiss(rec.id)} aria-label={`Dismiss the note about ${rec.resource}`}>
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
