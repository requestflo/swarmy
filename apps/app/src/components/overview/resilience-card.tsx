import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, LifeBuoyIcon } from 'lucide-react';

/** Estate resilience score — links out to the drills & readiness surface. */
export function ResilienceCard({
  score,
  headline,
}: {
  score: number | null;
  headline: string | null;
}): React.JSX.Element {
  const tone = score == null ? 'idle' : score >= 80 ? 'online' : score >= 50 ? 'warning' : 'offline';
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Resilience</h2>
        <LifeBuoyIcon className="text-muted-foreground size-4" />
      </div>
      {score == null ? (
        <p className="text-muted-foreground text-sm">Run a readiness check to get your score.</p>
      ) : (
        <>
          <div className="mono-data text-3xl font-bold" style={{ color: `var(--status-${tone})` }}>
            {score}%
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{headline}</p>
        </>
      )}
      {/* Resilience lives per-stack now (Backups tab) — send the user to pick a stack. */}
      <Link to="/" className="text-primary mt-2 inline-flex items-center gap-1 text-sm font-semibold">
        Drills live in each stack → Backups <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}
