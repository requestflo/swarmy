import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import type { OutcomeView } from './build-stage-model';

/**
 * "4e1c09a is live on checkout · 1 m 04 s total · health 3/3 · previous copy
 * drained" — the deploy that followed this build, once it settled. Links to
 * the app's canvas and its releases.
 */
export function BuildOutcome({ outcome }: { outcome: OutcomeView }): React.JSX.Element {
  return (
    <div
      role="status"
      className="calm-card flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3"
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[outcome.tone])} />
      <b className={cn('text-[13.5px]', outcome.tone === 'bad' && TONE_TEXT.bad)}>{outcome.title}</b>
      {outcome.meta ? <span className="text-muted-foreground font-mono text-[12px]">{outcome.meta}</span> : null}
      {outcome.stack ? (
        <span className="ml-auto flex gap-2">
          <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/stacks/$name" params={{ name: outcome.stack }}>Open canvas</Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/stacks/$name/releases" params={{ name: outcome.stack }}>Releases</Link>
          </Button>
        </span>
      ) : null}
    </div>
  );
}
