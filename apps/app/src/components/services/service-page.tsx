import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CalmPage, CodeView, useDepth, type Crumb } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { serviceCode } from './service-code';
import { ServicePageBody } from './service-page-body';
import type { ServiceTab } from './service-section-strip';

interface ServicePageProps {
  serviceId: string;
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
}

/**
 * The standalone service page (`/services/$serviceId`, board ServiceSheet) —
 * the deep-linkable home of the shared service body, in a calm page with the
 * live spec as code in the aside. From the canvas you land in the overlay.
 */
export function ServicePage({ serviceId, tab, onTabChange }: ServicePageProps): React.JSX.Element {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const svc = useQuery({ ...trpc.services.get.queryOptions({ id: serviceId }), refetchInterval: 3_000 });
  const s = svc.data;
  // The aside only exists at Code depth, so Summary and Controls get the full width.
  const code = useDepth().atLeast('code');
  const crumbs: Crumb[] = [
    { label: 'Apps', to: '/' },
    ...(s?.stackId ? [{ label: s.stackId, to: '/stacks/$name', params: { name: s.stackId } }] : []),
    { label: s?.name ?? 'service' },
  ];
  return (
    <CalmPage crumbs={crumbs} aside={s && code ? <CodeView title="This service as code" tabs={serviceCode(s)} source="readonly" /> : undefined}>
      <div>
        <ServicePageBody
          serviceId={serviceId}
          tab={tab}
          onTabChange={onTabChange}
          onSelectService={(id) =>
            void navigate({ to: '/services/$serviceId', params: { serviceId: id }, viewTransition: true })
          }
        />
      </div>
    </CalmPage>
  );
}
