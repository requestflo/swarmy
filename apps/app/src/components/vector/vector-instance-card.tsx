import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BoxIcon } from 'lucide-react';
import type { VectorInstanceView } from '@swarmy/core';
import { Button, CopyButton, StatusBadge, toast, type StatusTone } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { useTRPC } from '@/integrations/trpc';
import { AttachVectorForm } from './attach-vector-form';

function tone(view: VectorInstanceView): { tone: StatusTone; label: string } {
  if (view.status === 'absent') return { tone: 'offline', label: 'absent' };
  if (view.status === 'stopped' || view.running < 1) return { tone: 'offline', label: 'down' };
  if (view.status === 'deploying') return { tone: 'progress', label: 'deploying' };
  return { tone: 'online', label: 'healthy' };
}

/** One managed qdrant instance: status, collections, URL, attach + destroy. */
export function VectorInstanceCard({ view }: { view: VectorInstanceView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { tone: t, label } = tone(view);

  const destroy = useMutation(
    trpc.vector.destroy.mutationOptions({
      onSuccess: () => {
        toast.success(`Vector store ${view.name} removed`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="card-pop p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <BoxIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{view.name}</p>
            <p className="mono-label text-muted-foreground !mb-0">qdrant · {view.stack}</p>
          </div>
        </div>
        <StatusBadge tone={t} label={label} className="shrink-0" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Collections</p>
          <p className="mono-data text-sm">
            {view.stats ? <CountUp value={view.stats.collections} /> : '—'}
          </p>
        </div>
        <div>
          <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">Replicas</p>
          <p className="mono-data text-sm">
            {view.running}
            <span className="text-muted-foreground"> / {view.desired}</span>
          </p>
        </div>
      </div>

      <div className="bg-muted/40 mt-3 flex items-center justify-between gap-2 rounded-md px-3 py-2">
        <code className="mono-data truncate text-xs">{view.url}</code>
        <CopyButton value={view.url} />
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        API key lives in Docker secret <code className="mono-data">{view.keySecret}</code>.
      </p>

      {view.attachments.length > 0 ? (
        <p className="text-muted-foreground mt-2 truncate text-xs">
          Attached: {view.attachments.map((a) => a.service).join(', ')}
        </p>
      ) : null}

      <div className="mt-3 flex items-end justify-between gap-2">
        <AttachVectorForm stack={view.stack} name={view.name} />
        <Button
          size="sm"
          variant="outline"
          className="text-status-offline shrink-0"
          disabled={destroy.isPending}
          onClick={() => {
            if (window.confirm(`Destroy vector store ${view.stack}/${view.name}? The data volume is kept.`)) {
              destroy.mutate({ stack: view.stack, name: view.name, force: false });
            }
          }}
        >
          Destroy
        </Button>
      </div>
    </div>
  );
}
