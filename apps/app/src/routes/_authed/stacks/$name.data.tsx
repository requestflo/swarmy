import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ManagedDbPanel } from '@/components/stacks/managed-db-panel';
import { CacheSection } from '@/components/cache/cache-section';
import { SearchSection } from '@/components/searchsvc/search-section';
import { VectorSection } from '@/components/vector/vector-section';

/**
 * Data tab of the stack workspace: this stack's managed databases, caches,
 * search engines and vector stores — all inline-first (row-expands and
 * Collapsible provision cards, no modals).
 */
export const Route = createFileRoute('/_authed/stacks/$name/data')({
  component: DataTab,
});

function DataTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <div className="space-y-6">
      <ManagedDbPanel stack={name} />
      <CacheSection stack={name} />
      <SearchSection stack={name} />
      <VectorSection stack={name} />
    </div>
  );
}
