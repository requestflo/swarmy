import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SERVICE_STATUS_TONE } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { RegionPlanEditor } from '@/components/stacks/region-plan-editor';
import { AppIngressPanel } from '@/components/stacks/app-ingress-panel';
import { AppCicdPanel } from '@/components/stacks/app-cicd-panel';
import { ServiceInspectorHeader } from './service-inspector-header';
import { ServiceScaleStepper } from './service-scale-stepper';
import { ServiceScaleToZeroCard } from './service-scale-to-zero-card';
import { ServicePortsList } from './service-ports-list';
import { ServiceQuickActions } from './service-quick-actions';
import { ServiceRemoveConfirm } from './service-remove-confirm';
import { ServiceDefinitionSection } from './service-definition-section';

interface ServiceInspectorPanelProps {
  serviceId: string;
  onClose: () => void;
}

/**
 * Docked inspector content for a canvas service node: live status + quick
 * scale + jump-to actions. Replaces the old slide-over sheet — this mounts as
 * the content of `CanvasInspector`, a real layout column, never an overlay.
 */
export function ServiceInspectorPanel({ serviceId, onClose }: ServiceInspectorPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const svc = useQuery({
    ...trpc.services.get.queryOptions({ id: serviceId }),
    refetchInterval: 4_000,
  });
  const invalidate = (): void => void qc.invalidateQueries();
  const scale = useMutation(trpc.services.scale.mutationOptions({ onSuccess: invalidate }));
  const restart = useMutation(trpc.services.restart.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.services.remove.mutationOptions({ onSuccess: invalidate }));
  const setS2z = useMutation(trpc.services.setScaleToZero.mutationOptions({ onSuccess: invalidate }));
  const wake = useMutation(trpc.services.wake.mutationOptions({ onSuccess: invalidate }));

  const s = svc.data;
  if (!s) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">{svc.isLoading ? 'Loading service…' : 'Service not found.'}</p>
      </div>
    );
  }

  const tone = SERVICE_STATUS_TONE[s.status] ?? 'neutral';
  const asleep = !!s.scaleToZero?.enabled && s.replicas.desired === 0;

  return (
    <>
      <ServiceInspectorHeader name={s.name} tone={tone} status={s.status} stack={s.stackId} onClose={onClose} />
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <div>
          <p className="mono-label">Image</p>
          <p className="mono-data mt-1 text-sm break-all">{s.image}</p>
        </div>

        <ServiceScaleStepper
          running={s.replicas.running}
          desired={s.replicas.desired}
          pending={scale.isPending}
          onScale={(replicas) => scale.mutate({ id: s.id, replicas })}
        />

        <ServicePortsList ports={s.ports} />

        <ServiceScaleToZeroCard
          enabled={!!s.scaleToZero?.enabled}
          idleSeconds={s.scaleToZero?.idleSeconds ?? 300}
          asleep={asleep}
          loading={svc.isLoading}
          pending={setS2z.isPending}
          wakePending={wake.isPending}
          onToggle={(enabled) => setS2z.mutate({ id: s.id, enabled })}
          onWake={() => wake.mutate({ id: s.id })}
        />

        <RegionPlanEditor serviceId={s.id} />
        <AppIngressPanel serviceId={s.id} serviceName={s.name} />
        <AppCicdPanel serviceId={s.id} serviceName={s.name} />

        <ServiceDefinitionSection serviceId={s.id} />

        <ServiceQuickActions serviceId={s.id} restarting={restart.isPending} onRestart={() => restart.mutate({ id: s.id })} />

        <ServiceRemoveConfirm
          name={s.name}
          pending={remove.isPending}
          onConfirm={() => {
            remove.mutate({ id: s.id });
            onClose();
          }}
        />
      </div>
    </>
  );
}
