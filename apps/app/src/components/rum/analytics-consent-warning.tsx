import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';

/** Identified mode with no consent gate: say what that means and where to fix it. */
export function AnalyticsConsentWarning({ stack }: { stack: string }): React.JSX.Element {
  return (
    <div
      role="alert"
      className="border-status-warning/40 bg-status-warning/8 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm"
    >
      <TriangleAlertIcon className="text-status-warning size-4 shrink-0" />
      <b>Needs consent</b>
      <span className="text-muted-foreground min-w-0 flex-1">
        Identified mode ties visits to people — that's personal data. Wire the consent hook so only
        visitors who agree are identified.
      </span>
      <Link
        to="/stacks/$name/rum-settings"
        params={{ name: stack }}
        hash="consent"
        className="border-border hover:bg-accent rounded-full border px-3 py-1 text-xs font-semibold"
      >
        Wire the consent hook
      </Link>
    </div>
  );
}
