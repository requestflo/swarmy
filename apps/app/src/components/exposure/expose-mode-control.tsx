import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPOSE_MODES, EXPOSE_MODE_LABELS, type ExposeMode } from '@swarmy/core';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const UNSET = 'unset';

/**
 * Compact declared-exposure selector (`swarmy.expose` label, Docker truth):
 * Public / Tunnel / Private / Mesh-only, or unset (audit-only). Declaring a
 * mode makes the exposure audit drift-check the service and lets admission
 * refuse deploys that contradict it. Shows a drift badge when declared ≠
 * observed.
 */
export function ExposeModeControl({ serviceId }: { serviceId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const overview = useQuery(trpc.exposure.overview.queryOptions());
  const row = overview.data?.rows.find((r) => r.serviceId === serviceId);

  const setMode = useMutation(
    trpc.exposure.setMode.mutationOptions({
      onSuccess: (out) => {
        toast.success(
          out.mode
            ? `Exposure declared: ${EXPOSE_MODE_LABELS[out.mode]}`
            : 'Exposure declaration cleared',
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <span className="flex items-center justify-end gap-2">
      {row?.drift ? (
        <StatusBadge
          tone={row.drift.level === 'violation' ? 'offline' : 'warning'}
          label="drift"
        />
      ) : null}
      <Select
        value={row?.declared ?? UNSET}
        onValueChange={(v) =>
          setMode.mutate({ id: serviceId, mode: v === UNSET ? null : (v as ExposeMode) })
        }
        disabled={overview.isLoading || setMode.isPending}
      >
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue placeholder="Unset" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Unset</SelectItem>
          {EXPOSE_MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {EXPOSE_MODE_LABELS[mode]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}
