import * as React from 'react';
import { ScrollTextIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import type { AuditEntryView } from '@swarmy/core';
import { AuditRow } from './audit-row';

/** The timeline: flat rows in one card, hairline-divided, each expanding inline. */
export function AuditTable({
  entries,
  isLoading,
  isError,
  errorMessage,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
}: {
  entries: AuditEntryView[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="card-pop space-y-3 p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="shimmer-line h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card-pop p-6 text-center">
        <p className="text-status-offline text-sm font-medium">
          Couldn't load the audit log{errorMessage ? ` — ${errorMessage}` : ''}.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="card-pop p-2">
        <EmptyState
          icon={<ScrollTextIcon />}
          title="Nothing matches these filters"
          description="Every mutation in the org is recorded here the moment it happens — clear a filter or widen the date range."
        />
      </div>
    );
  }

  return (
    <div className="card-pop divide-border divide-y overflow-hidden">
      {entries.map((e) => (
        <AuditRow
          key={e.id}
          entry={e}
          expanded={expandedId === e.id}
          onToggle={() => setExpandedId((id) => (id === e.id ? null : e.id))}
        />
      ))}
      {hasNextPage ? (
        <div className="flex justify-center p-3">
          <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
            {isFetchingNextPage ? 'Loading…' : 'Load older entries'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
