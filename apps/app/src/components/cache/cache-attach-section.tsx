import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, UnlinkIcon } from 'lucide-react';
import type { CacheClusterView } from '@swarmy/core';
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

/**
 * Attached apps: who is wired to this cluster (REDIS_URL + password secret),
 * plus a picker to attach another service from the same stack.
 */
export function CacheAttachSection({ view }: { view: CacheClusterView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [candidate, setCandidate] = React.useState('');
  const services = useQuery(trpc.services.list.queryOptions({}));

  const attach = useMutation(
    trpc.cache.attachToService.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} wired — ${r.envVar} + password secret injected`);
        setCandidate('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const detach = useMutation(
    trpc.cache.detach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} detached`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const attachedNames = new Set(view.attachments.map((a) => a.service));
  const candidates = (services.data ?? []).filter(
    (s) => !attachedNames.has(s.name) && !s.name.startsWith(`${view.stack}_${view.name}-cache`),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Attached apps</p>
      {view.attachments.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing wired yet — attach a service to inject{' '}
          <code className="mono-data">REDIS_URL</code> and the password secret.
        </p>
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {view.attachments.map((a) => (
            <div key={a.service} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <code className="mono-data block truncate text-xs">{a.service}</code>
                <p className="mono-label text-muted-foreground !mb-0 !text-[10px]">{a.envVar}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={detach.isPending}
                onClick={() =>
                  detach.mutate({ stack: view.stack, cluster: view.name, appService: a.service })
                }
              >
                <UnlinkIcon className="size-3.5" /> Detach
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Select value={candidate || undefined} onValueChange={setCandidate}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Pick a service to attach" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((s) => (
              <SelectItem key={s.id} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={!candidate || attach.isPending}
          onClick={() =>
            attach.mutate({
              stack: view.stack,
              cluster: view.name,
              appService: candidate,
              envVar: 'REDIS_URL',
            })
          }
        >
          <LinkIcon className="size-3.5" /> Attach
        </Button>
      </div>
    </section>
  );
}
