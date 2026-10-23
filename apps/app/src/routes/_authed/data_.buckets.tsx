import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BucketsPage } from '@/components/buckets/buckets-page';

interface BucketsSearch {
  /** Open the "New bucket" card (Data → Add data → A bucket for files). */
  create?: boolean;
}

export const Route = createFileRoute('/_authed/data_/buckets')({
  validateSearch: (search: Record<string, unknown>): BucketsSearch =>
    search.create === true || search.create === 'true' ? { create: true } : {},
  component: BucketsRoute,
});

function BucketsRoute(): React.JSX.Element {
  const { create } = Route.useSearch();
  return <BucketsPage startCreating={create === true} />;
}
