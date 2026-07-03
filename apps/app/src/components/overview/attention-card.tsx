import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, BellIcon } from 'lucide-react';

function RowLink({ to, tone, children }: { to: string; tone: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Link
      to={to}
      className="hover:bg-accent flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors"
    >
      <span className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: `var(--status-${tone})` }} />
        {children}
      </span>
      <ArrowRightIcon className="text-muted-foreground size-3.5" />
    </Link>
  );
}

/** What's firing right now — links straight into the ops pages. */
export function AttentionCard({
  firing,
  openIncidents,
}: {
  firing: number;
  openIncidents: number;
}): React.JSX.Element {
  const calm = firing === 0 && openIncidents === 0;
  return (
    <div className="card-pop p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Needs attention</h2>
        <BellIcon className="text-muted-foreground size-4" />
      </div>
      {calm ? (
        <p className="text-muted-foreground text-sm">Nothing on fire. Quiet and green.</p>
      ) : (
        <div className="space-y-2">
          {firing > 0 && (
            <RowLink to="/alerts" tone="warning">
              {firing} alert{firing === 1 ? '' : 's'} firing
            </RowLink>
          )}
          {openIncidents > 0 && (
            <RowLink to="/incidents" tone="offline">
              {openIncidents} open incident{openIncidents === 1 ? '' : 's'}
            </RowLink>
          )}
        </div>
      )}
    </div>
  );
}
