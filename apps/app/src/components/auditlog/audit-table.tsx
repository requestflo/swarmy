import * as React from 'react';
import { Button } from '@swarmy/ui';
import type { AuditEntryView } from '@swarmy/core';
import { Section } from '@/components/calm';
import { ErrorState, SkeletonBody } from '@/components/states';
import { AuditRow } from './audit-row';

/** The trail: one quiet section, hairline rows, each opening its full record inline. */
export function AuditTable({
  entries,
  isLoading,
  isError,
  errorMessage,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  toolbar,
}: {
  entries: AuditEntryView[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  toolbar?: React.ReactNode;
}): React.JSX.Element {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  if (isLoading) return <SkeletonBody variant="list" />;
  if (isError) return <ErrorState title="Couldn’t load the audit log." error={errorMessage} retry={onRetry} />;
  return (
    <Section title="Who did what" count={`${entries.length}${hasNextPage ? '+' : ''} entries`} hint="newest first" flush>
      {toolbar ? <div className="flex flex-col gap-3 pb-3">{toolbar}</div> : null}
      {entries.length === 0 ? (
        <p className="text-muted-foreground py-6 text-sm">Nothing matches. Clear a filter or widen the dates; every change is recorded the moment it happens.</p>
      ) : (
        entries.map((e) => (
          <AuditRow key={e.id} entry={e} expanded={expandedId === e.id} onToggle={() => setExpandedId((id) => (id === e.id ? null : e.id))} />
        ))
      )}
      {hasNextPage ? (
        <div className="flex justify-center py-3">
          <Button variant="ghost" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore} className="pointer-coarse:min-h-11">
            {isFetchingNextPage ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
