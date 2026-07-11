import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ServerCrashIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ServiceDeployBanner } from './service-deploy-banner';
import { ServiceFlowStrip } from './service-flow-strip';
import { ServiceHero } from './service-hero';
import { ServicePulseRow } from './service-pulse-row';
import { ServiceSections } from './service-sections';
import { ServiceSectionStrip, type ServiceTab } from './service-section-strip';
import { useServiceContainers } from './use-service-containers';

interface ServicePageBodyProps {
  serviceId: string;
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
  /** Jump to another service — the overlay coverflows, the page navigates. */
  onSelectService: (id: string) => void;
  /** Overlay mode: no breadcrumb (the canvas is right behind you), tighter hero. */
  compact?: boolean;
}

/**
 * Everything inside a service — hero, pulse row, data flow, then one
 * jobs-to-be-done section at a time. Shared verbatim between the full page
 * (`/services/$serviceId`) and the canvas overlay, so the two surfaces never
 * drift apart.
 */
export function ServicePageBody({
  serviceId,
  tab,
  onTabChange,
  onSelectService,
  compact,
}: ServicePageBodyProps): React.JSX.Element {
  const trpc = useTRPC();
  const svc = useQuery({ ...trpc.services.get.queryOptions({ id: serviceId }), refetchInterval: 3_000 });
  const deploy = useQuery({
    ...trpc.services.deployStatus.queryOptions({ serviceId }),
    refetchInterval: 2_000,
  });
  const containers = useServiceContainers(serviceId);

  const s = svc.data;
  if (!s) {
    return svc.isLoading ? (
      <div className="grid gap-4 pt-10">
        <div className="shimmer-line h-10 w-1/3" />
        <div className="shimmer-line h-6 w-1/2" />
        <div className="shimmer-line h-32 w-full" />
      </div>
    ) : (
      <EmptyState
        icon={<ServerCrashIcon />}
        title="That service isn't here"
        description="It may have been removed, or the link is stale."
        action={
          <Button asChild className="font-bold">
            <Link to="/services">Back to services</Link>
          </Button>
        }
      />
    );
  }

  const asleep = !!s.scaleToZero?.enabled && s.replicas.desired === 0;
  const deploying = !!deploy.data && deploy.data.phase !== 'complete' && deploy.data.phase !== 'failed';

  return (
    <>
      <ServiceHero service={s} deploying={deploying} asleep={asleep} compact={compact} />
      <ServicePulseRow service={s} containers={containers} deploy={deploy.data ?? undefined} onJump={onTabChange} />
      <ServiceFlowStrip serviceId={s.id} onSelect={onSelectService} />
      {deploying && deploy.data ? (
        <div className="mt-6">
          <ServiceDeployBanner deploy={deploy.data} desired={s.replicas.desired} />
        </div>
      ) : null}
      <ServiceSectionStrip tab={tab} onTabChange={onTabChange} />
      <ServiceSections tab={tab} service={s} containers={containers} asleep={asleep} onJump={onTabChange} />
    </>
  );
}
