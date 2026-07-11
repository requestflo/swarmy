import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ServicePageBody } from './service-page-body';
import type { ServiceTab } from './service-section-strip';

interface ServicePageProps {
  serviceId: string;
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
}

/**
 * The standalone service page (`/services/$serviceId`) — the deep-linkable
 * home of the shared service body. From the canvas you'd normally land in the
 * overlay instead; this page is where global links (services list, command
 * palette, exposure views) arrive.
 */
export function ServicePage({ serviceId, tab, onTabChange }: ServicePageProps): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-6 pb-24 xl:px-10 lg:pb-20">
      <ServicePageBody
        serviceId={serviceId}
        tab={tab}
        onTabChange={onTabChange}
        onSelectService={(id) =>
          void navigate({ to: '/services/$serviceId', params: { serviceId: id }, viewTransition: true })
        }
      />
    </div>
  );
}
