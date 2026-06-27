import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MinusIcon, PlusIcon, RotateCwIcon, ScrollTextIcon, SquareTerminalIcon, Trash2Icon } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetHeader, SheetTitle, StatusBadge } from '@swarmy/ui';
import { SERVICE_STATUS_TONE } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/** Slide-over for a canvas service: live status + quick scale + jump-to actions. */
export function ServiceDetailSheet({
  serviceId,
  onOpenChange,
}: {
  serviceId: string | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const svc = useQuery({
    ...trpc.services.get.queryOptions({ id: serviceId ?? '' }),
    enabled: !!serviceId,
    refetchInterval: 4_000,
  });
  const invalidate = () => qc.invalidateQueries();
  const scale = useMutation(trpc.services.scale.mutationOptions({ onSuccess: invalidate }));
  const restart = useMutation(trpc.services.restart.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.services.remove.mutationOptions({ onSuccess: invalidate }));

  const s = svc.data;
  const tone = s ? (SERVICE_STATUS_TONE[s.status] ?? 'neutral') : 'neutral';

  return (
    <Sheet open={!!serviceId} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-2 text-2xl">{s?.name ?? 'Service'}</SheetTitle>
          {s && <StatusBadge tone={tone} label={s.status} />}
        </SheetHeader>

        {s && (
          <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
            <div>
              <p className="mono-label">Image</p>
              <p className="mono-data mt-1 break-all text-sm">{s.image}</p>
            </div>

            <div>
              <p className="mono-label">Replicas</p>
              <div className="mt-2 flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={scale.isPending || s.replicas.desired <= 0}
                  onClick={() => scale.mutate({ id: s.id, replicas: Math.max(0, s.replicas.desired - 1) })}
                >
                  <MinusIcon className="size-4" />
                </Button>
                <span className="mono-data text-2xl tabular-nums">
                  {s.replicas.running}/{s.replicas.desired}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={scale.isPending}
                  onClick={() => scale.mutate({ id: s.id, replicas: s.replicas.desired + 1 })}
                >
                  <PlusIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" disabled={restart.isPending} onClick={() => restart.mutate({ id: s.id })}>
                <RotateCwIcon className="size-4" /> Restart
              </Button>
              <Button variant="outline" onClick={() => navigate({ to: '/services/$serviceId', params: { serviceId: s.id } })}>
                <ScrollTextIcon className="size-4" /> Details
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate({ to: '/services/$serviceId/terminal', params: { serviceId: s.id } })}
              >
                <SquareTerminalIcon className="size-4" /> Terminal
              </Button>
              <Button
                variant="outline"
                className="text-status-offline"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate({ id: s.id });
                  onOpenChange(false);
                }}
              >
                <Trash2Icon className="size-4" /> Remove
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
