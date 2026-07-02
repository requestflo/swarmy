import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ShieldAlertIcon, ShieldCheckIcon, WrenchIcon } from 'lucide-react';
import type { ExposureViolationView } from '@swarmy/core';
import { StatusBadge } from '@swarmy/ui';

/**
 * The violations feed: every live rule violation with a concrete fix hint.
 * v1 never auto-remediates — the card says so, plainly.
 */
export function ExposureViolations({
  violations,
  isLoading,
}: {
  violations: ExposureViolationView[];
  isLoading: boolean;
}): React.JSX.Element {
  return (
    <section className="card-pop overflow-hidden">
      <header className="border-border flex items-center justify-between border-b px-5 py-3">
        <span className="mono-label !mb-0">Violations</span>
        {violations.length > 0 ? (
          <StatusBadge tone="offline" label={`${violations.length} live`} />
        ) : null}
      </header>

      {isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : violations.length === 0 ? (
        <div className="flex items-start gap-3 px-5 py-4">
          <ShieldCheckIcon className="text-status-online mt-0.5 size-4 shrink-0" />
          <p className="text-muted-foreground text-sm">
            Nothing violates your exposure rules right now.
          </p>
        </div>
      ) : (
        <div className="divide-border divide-y">
          {violations.map((v) => (
            <div key={`${v.serviceId}:${v.rule}`} className="space-y-1.5 px-5 py-3.5">
              <div className="flex items-start gap-2">
                <ShieldAlertIcon className="text-status-offline mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <Link
                    to="/services/$serviceId"
                    params={{ serviceId: v.serviceId }}
                    className="mono-data hover:text-primary text-sm font-semibold transition-colors"
                  >
                    {v.stack}/{v.serviceName}
                  </Link>
                  <p className="text-sm">{v.message}</p>
                </div>
              </div>
              <p className="text-muted-foreground flex items-start gap-1.5 pl-6 text-xs">
                <WrenchIcon className="mt-0.5 size-3 shrink-0" />
                {v.fixHint}
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground border-border border-t px-5 py-2.5 text-[11px]">
        swarmy alerts on violations but never removes a port itself (v1) — the fix is always
        yours to make.
      </p>
    </section>
  );
}
