import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceDetail } from '@swarmy/core';
import { Card, CardContent, CardHeader, CardTitle, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RegionPlanEditor } from './region-plan-editor';
import { ServiceScaleStepper } from './service-scale-stepper';
import { ServiceScaleToZeroCard } from './service-scale-to-zero-card';

interface ServiceScalePanelProps {
  service: ServiceDetail;
  asleep: boolean;
}

/** "Scale" — replicas, sleep-when-idle, and the multi-region plan in one place. */
export function ServiceScalePanel({ service, asleep }: ServiceScalePanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();

  const scale = useMutation(
    trpc.services.scale.mutationOptions({
      onSuccess: () => {
        toast.success('Scaling');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setS2z = useMutation(
    trpc.services.setScaleToZero.mutationOptions({
      onSuccess: invalidate,
      onError: (e) => toast.error(e.message),
    }),
  );
  const wake = useMutation(
    trpc.services.wake.mutationOptions({
      onSuccess: () => {
        toast.success('Waking it up');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Replicas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          <ServiceScaleStepper
            running={service.replicas.running}
            desired={service.replicas.desired}
            pending={scale.isPending}
            onScale={(replicas) => scale.mutate({ id: service.id, replicas })}
          />
          <ServiceScaleToZeroCard
            enabled={!!service.scaleToZero?.enabled}
            idleSeconds={service.scaleToZero?.idleSeconds ?? 300}
            asleep={asleep}
            loading={false}
            pending={setS2z.isPending}
            wakePending={wake.isPending}
            onToggle={(enabled) => setS2z.mutate({ id: service.id, enabled })}
            onWake={() => wake.mutate({ id: service.id })}
          />
        </CardContent>
      </Card>

      {/* Renders nothing when the swarm has no regions in play. */}
      <RegionPlanEditor serviceId={service.id} />
    </div>
  );
}
