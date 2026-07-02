import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Inline attach: pick a service → it gets QDRANT_URL + the key secret. */
export function AttachVectorForm({
  stack,
  name,
}: {
  stack: string;
  name: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [service, setService] = React.useState('');
  const services = useQuery(trpc.services.list.queryOptions({}));

  const attach = useMutation(
    trpc.vector.attachToService.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} now has ${r.envVar}`);
        setService('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select value={service || 'none'} onValueChange={(v) => setService(v === 'none' ? '' : v)}>
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
          <SelectValue placeholder="Attach app…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Attach app…</SelectItem>
          {(services.data ?? []).map((s) => (
            <SelectItem key={s.id} value={s.name}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={!service || attach.isPending}
        onClick={() => attach.mutate({ stack, name, appService: service, envVar: 'QDRANT_URL' })}
      >
        {attach.isPending ? 'Attaching…' : 'Attach'}
      </Button>
    </div>
  );
}
