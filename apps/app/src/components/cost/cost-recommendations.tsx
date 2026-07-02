import * as React from 'react';
import { LightbulbIcon, XIcon } from 'lucide-react';
import type { CostRecommendationView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { useDismissedRecs } from './use-dismissed-recs';

/**
 * The recommendations feed: rule-generated saving/setup nudges with a per-item
 * dismiss (persisted in localStorage — ids are stable) and a restore link.
 */
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
    <section className="card-pop overflow-hidden">
      <header className="border-border flex items-center justify-between border-b px-5 py-3">
        <span className="mono-label !mb-0 flex items-center gap-1.5">
          <LightbulbIcon className="size-3.5" />
          Recommendations
          {visible.length > 0 ? <span className="text-muted-foreground">· {visible.length}</span> : null}
        </span>
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={restoreAll}
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
          >
            show {hiddenCount} dismissed
          </button>
        ) : null}
      </header>

      {isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-center text-sm">
          {recommendations.length === 0
            ? 'Nothing to trim — the estate looks right-sized.'
            : 'All recommendations dismissed.'}
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {visible.map((rec) => (
            <li key={rec.id} className="group flex items-start gap-3 px-5 py-3.5">
              <span
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  rec.savingsUsd != null ? 'bg-status-warning' : 'bg-status-progress',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug">{rec.message}</span>
                <span className="text-muted-foreground mono-data text-xs">
                  {rec.resource}
                  {rec.savingsUsd != null ? ` · ~$${rec.savingsUsd}/mo` : ''}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 opacity-40 transition-opacity group-hover:opacity-100"
                onClick={() => dismiss(rec.id)}
                aria-label={`Dismiss recommendation for ${rec.resource}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
