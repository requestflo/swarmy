import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceDetail } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { SettingRow } from './settings-row';

/** Sleep when idle (scale to zero) — applied at once, it's a label, not a rollout. */
export function SleepRow({ service }: { service: ServiceDetail }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const set = useMutation(trpc.services.setScaleToZero.mutationOptions({ onSuccess: () => void qc.invalidateQueries(), onError }));
  const wake = useMutation(
    trpc.services.wake.mutationOptions({
      onSuccess: () => {
        toast.success('Waking it up');
        void qc.invalidateQueries();
      },
      onError,
    }),
  );
  const s2z = service.scaleToZero;
  const enabled = !!s2z?.enabled;
  const asleep = enabled && service.replicas.desired === 0;
  const idle = s2z?.idleSeconds ?? 300;
  return (
    <SettingRow title="Sleep when idle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px]">
          {asleep ? 'Asleep now; the next visit wakes it.' : enabled ? `Sleeps after ${idle} s with no visits and wakes on the next one.` : 'Always on, even when nobody is visiting.'}
        </p>
        <div className="flex items-center gap-2">
          {asleep ? (
            <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={wake.isPending} onClick={() => wake.mutate({ id: service.id })}>
              Wake now
            </Button>
          ) : null}
          <QuietSwitch
            aria-label="Sleep when idle"
            checked={enabled}
            disabled={set.isPending}
            onCheckedChange={(v) => {
              if (v !== enabled && !set.isPending) set.mutate({ id: service.id, enabled: v });
            }}
          />
        </div>
      </div>
      <Tech>swarmy.scale-to-zero {enabled ? `on · idle ${idle}s · wakes to ${s2z?.targetReplicas ?? 1}` : 'off'}</Tech>
    </SettingRow>
  );
}
