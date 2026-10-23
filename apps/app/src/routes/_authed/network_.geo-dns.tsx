import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { GeoDnsPage } from '@/components/geo/geodns-page';

/** Network › Geo-DNS. `?zone=` picks the zone (else the first one swarmy serves). */
interface GeoDnsSearch {
  zone?: string;
}

export const Route = createFileRoute('/_authed/network_/geo-dns')({
  validateSearch: (search: Record<string, unknown>): GeoDnsSearch =>
    typeof search.zone === 'string' && search.zone ? { zone: search.zone.slice(0, 253) } : {},
  component: GeoDnsRoute,
});

function GeoDnsRoute(): React.JSX.Element {
  const { zone } = Route.useSearch();
  return <GeoDnsPage zone={zone} />;
}
