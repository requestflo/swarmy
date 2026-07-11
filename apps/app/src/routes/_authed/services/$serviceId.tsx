import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ServicePage } from '@/components/services/service-page';
import { isServiceTab, type ServiceTab } from '@/components/services/service-section-strip';

interface ServiceSearch {
  tab?: ServiceTab;
}

export const Route = createFileRoute('/_authed/services/$serviceId')({
  // `tab` stays optional so plain links land on the default section with a clean URL.
  validateSearch: (search: Record<string, unknown>): ServiceSearch =>
    isServiceTab(search.tab) ? { tab: search.tab } : {},
  component: ServiceDetailPage,
});

function ServiceDetailPage(): React.JSX.Element {
  const { serviceId } = Route.useParams();
  const { tab = 'inside' } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ServicePage
      serviceId={serviceId}
      tab={tab}
      onTabChange={(next) => void navigate({ search: { tab: next }, replace: true })}
    />
  );
}
