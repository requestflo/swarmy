import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { GlobeIcon, LockIcon, DatabaseIcon } from 'lucide-react';
import { EXPOSE_MODE_LABELS, type ExposureIntentRowView, type ExposureRowView } from '@swarmy/core';
import { StatusBadge, cn } from '@swarmy/ui';

/**
 * The audit table — flat rows in one card, grouped Public / Private /
 * Managed-internal. Public rows carry an "expected?" nudge; rows that violate
 * a rule get a crimson badge; rows whose DECLARED mode (`swarmy.expose`)
 * disagrees with the observed verdict get a drift badge.
 */

interface Group {
  key: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
  rows: ExposureIntentRowView[];
}

function groupRows(rows: ExposureIntentRowView[]): Group[] {
  const pub = rows.filter((r) => r.exposure === 'public-port' || r.exposure === 'public-domain');
  const managed = rows.filter((r) => r.exposure === 'internal-managed');
  const priv = rows.filter((r) => r.exposure === 'private');
  return [
    {
      key: 'public',
      title: 'Public',
      hint: 'Reachable from the internet — domains behind the ingress, ports published on every node.',
      icon: <GlobeIcon className="size-3.5" />,
      rows: pub,
    },
    {
      key: 'private',
      title: 'Private',
      hint: 'Overlay networking only — nothing published, no domains.',
      icon: <LockIcon className="size-3.5" />,
      rows: priv,
    },
    {
      key: 'managed',
      title: 'Managed internal',
      hint: 'swarmy-managed databases, caches, search and vector stores — private by design.',
      icon: <DatabaseIcon className="size-3.5" />,
      rows: managed,
    },
  ].filter((g) => g.rows.length > 0);
}

function RowBadge({ row, violating }: { row: ExposureRowView; violating: boolean }): React.JSX.Element {
  if (violating) return <StatusBadge tone="offline" label="rule violation" />;
  switch (row.exposure) {
    case 'public-domain':
      return <StatusBadge tone="online" label="public · domain" />;
    case 'public-port':
      return <StatusBadge tone="warning" label="public · port" />;
    case 'internal-managed':
      return <StatusBadge tone="neutral" label={`managed ${row.managedKind ?? ''}`.trim()} />;
    default:
      return <StatusBadge tone="neutral" label="private" />;
  }
}

/** Declared mode chip + drift badge — only rendered for services that declare. */
function DeclaredBadges({ row }: { row: ExposureIntentRowView }): React.JSX.Element | null {
  if (!row.declared) return null;
  return (
    <span className="flex items-center justify-end gap-1.5">
      <StatusBadge tone="neutral" label={`declared ${EXPOSE_MODE_LABELS[row.declared].toLowerCase()}`} />
      {row.drift ? (
        <StatusBadge
          tone={row.drift.level === 'violation' ? 'offline' : 'warning'}
          label="drift"
        />
      ) : null}
    </span>
  );
}

export function ExposureTable({
  rows,
  violatingIds,
}: {
  rows: ExposureIntentRowView[];
  violatingIds: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      {groupRows(rows).map((group) => (
        <section key={group.key} className="card-pop overflow-hidden">
          <header className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3">
            <span className="mono-label !mb-0 flex items-center gap-1.5">
              {group.icon}
              {group.title}
              <span className="text-muted-foreground">· {group.rows.length}</span>
            </span>
            <span className="text-muted-foreground text-xs">{group.hint}</span>
          </header>
          <div className="divide-border divide-y">
            {group.rows.map((row) => {
              const violating = violatingIds.has(row.serviceId);
              const isPublic = group.key === 'public';
              return (
                <div
                  key={row.serviceId}
                  className={cn(
                    'hover:bg-accent/50 grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 transition-colors sm:grid-cols-[220px_1fr_auto]',
                    violating && 'border-l-[3px] border-l-status-offline',
                  )}
                >
                  <span className="min-w-0">
                    <Link
                      to="/services/$serviceId"
                      params={{ serviceId: row.serviceId }}
                      className="mono-data hover:text-primary block truncate text-sm font-semibold transition-colors"
                    >
                      {row.serviceName}
                    </Link>
                    <span className="text-muted-foreground block truncate text-xs">{row.stack}</span>
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    {row.details.map((d) => (
                      <span key={d} className="text-muted-foreground mono-data block truncate text-xs">
                        {d}
                      </span>
                    ))}
                    {row.drift ? (
                      <span
                        className={cn(
                          'block text-[11px]',
                          row.drift.level === 'violation'
                            ? 'text-status-offline'
                            : 'text-status-warning',
                        )}
                      >
                        Drift: {row.drift.message}.
                      </span>
                    ) : isPublic && !violating && !row.declared ? (
                      <span className="text-status-warning block text-[11px]">
                        Expected? If not, remove the published port / route.
                      </span>
                    ) : null}
                  </span>
                  <span className="grid justify-items-end gap-1 justify-self-end">
                    <RowBadge row={row} violating={violating} />
                    <DeclaredBadges row={row} />
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
