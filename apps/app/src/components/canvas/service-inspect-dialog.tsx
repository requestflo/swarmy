import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Raw `docker service inspect` viewer — the complete spec + task/update status
 * for one service, surfaced on demand for the details/debug view. The structured
 * detail sheet only carries summary fields; this shows Docker truth verbatim.
 */
export function ServiceInspectDialog({
  serviceId,
  serviceName,
  open,
  onOpenChange,
}: {
  serviceId: string | null;
  serviceName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const inspect = useQuery({
    ...trpc.services.inspect.queryOptions({ id: serviceId ?? '' }),
    enabled: open && !!serviceId,
  });

  const json = inspect.data ? JSON.stringify(inspect.data, null, 2) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Inspect{serviceName ? ` · ${serviceName}` : ''}</DialogTitle>
          <DialogDescription>Full raw `docker service inspect` (spec + task &amp; update status).</DialogDescription>
        </DialogHeader>

        <div className="bg-muted/30 border-border max-h-[60vh] overflow-auto rounded-lg border p-3">
          {inspect.isLoading && <p className="text-muted-foreground text-sm">Loading inspect…</p>}
          {inspect.isError && (
            <p className="text-status-offline text-sm">Failed to inspect: {inspect.error.message}</p>
          )}
          {!inspect.isLoading && !inspect.isError && (
            <pre className="mono-data text-xs break-all whitespace-pre-wrap">{json}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
