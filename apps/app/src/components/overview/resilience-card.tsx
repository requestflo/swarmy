import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, LifeBuoyIcon } from 'lucide-react';

/** How many things across the estate aren't protected yet — details live per stack (Backups tab). */
export function ResilienceCard({ unprotected }: { unprotected: number | null }): React.JSX.Element {
  const tone = unprotected == null ? 'idle' : unprotected === 0 ? 'online' : 'warning';
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Resilience</h2>
        <LifeBuoyIcon className="text-muted-foreground size-4" />
      </div>
      {unprotected == null ? (
        <p className="text-muted-foreground text-sm">Checking what's protected…</p>
      ) : (
        <>
          <div className="mono-data text-3xl font-bold" style={{ color: `var(--status-${tone})` }}>
            {unprotected}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {unprotected === 0 ? 'Everything is protected.' : `thing${unprotected === 1 ? ' isn’t' : 's aren’t'} protected yet`}
          </p>
        </>
      )}
      {/* Resilience lives per-stack now (Backups tab) — send the user to pick a stack. */}
      <Link to="/" className="text-primary mt-2 inline-flex items-center gap-1 text-sm font-semibold">
        See each app → Backups <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}
