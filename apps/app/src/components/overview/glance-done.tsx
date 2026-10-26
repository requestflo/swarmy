import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { rollbackSpanWords, type RollbackTimingView } from '@swarmy/core';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import type { GlanceDone } from './use-glance-actions';
import { useLastRollback } from './use-last-rollback';

function words(done: GlanceDone, last: RollbackTimingView | null | undefined): { title: string; body: string } {
  if (done.kind === 'put-back') {
    const kept = done.suspect ? ` ${releaseLabel(done.suspect)} stays in its history for later.` : '';
    if (last?.releaseId === done.releaseId) {
      return { title: `${done.app} is back on ${done.label}`, body: `Every copy is healthy. It took ${rollbackSpanWords(last.tookSec)}.${kept}` };
    }
    const before = last ? ` Last rollback took ${rollbackSpanWords(last.tookSec)}.` : '';
    return {
      title: `Putting back ${done.label}`,
      body: `${done.app} goes back to ${done.label} one copy at a time, and your data isn’t touched.${before}${kept}`,
    };
  }
  const n = done.count;
  return {
    title: 'Acknowledged',
    body: `${n === 1 ? 'The alert' : `The ${n} alerts`} behind it ${n === 1 ? 'is' : 'are'} marked as seen. The incident stays open until it’s resolved, and swarmy alerts again if it’s still failing at the next check.`,
  };
}

/**
 * What the glance just did, in place of the incident card; a put-back can be
 * undone from here too, and says how long it took once it's healthy.
 */
export function GlanceDoneCard({ done, busy, onUndo }: { done: GlanceDone; busy: boolean; onUndo: () => void }): React.JSX.Element {
  const last = useLastRollback(done.kind === 'put-back' ? done.app : null, 3_000);
  const { title, body } = words(done, last);
  const undo = done.kind === 'put-back' && done.suspect !== null;
  return (
    <section aria-live="polite" aria-label={title} className="calm-card flex flex-col gap-2.5 p-4">
      <p className="flex items-center gap-2.5 text-[16px] font-semibold">
        <CheckIcon aria-hidden className="text-tone-ok size-[18px] shrink-0" strokeWidth={2.6} />
        {title}
      </p>
      <p className="text-foreground/80 text-[14px] leading-normal">{body}</p>
      <div className="flex flex-wrap items-center gap-2">
        {undo ? (
          <Button variant="outline" size="sm" className="h-11 px-5" disabled={busy} onClick={onUndo}>
            Undo
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="h-11 px-4">
          <Link to="/activity" search={{ incident: done.incidentId }}>Open the incident</Link>
        </Button>
      </div>
    </section>
  );
}
