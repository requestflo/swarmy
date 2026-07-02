import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, UnlinkIcon } from 'lucide-react';
import type { SearchInstanceView } from '@swarmy/core';
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
 * Attached apps: who is wired to this instance (host env vars + key secret),
 * plus a picker to attach another service from the same stack.
 */
export function SearchAttachSection({ view }: { view: SearchInstanceView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [candidate, setCandidate] = React.useState('');
  const services = useQuery(trpc.services.list.queryOptions({}));

  const attach = useMutation(
    trpc.search.attachToService.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} wired — ${r.envVar} + key secret injected`);
        setCandidate('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const detach = useMutation(
    trpc.search.detach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.appService} detached`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const attachedNames = new Set(view.attachments.map((a) => a.service));
  const candidates = (services.data ?? []).filter(
    (s) => !attachedNames.has(s.name) && s.name !== view.service,
  );
  const hostVar = view.engine === 'typesense' ? 'TYPESENSE_HOST' : 'MEILI_HOST';

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Attached apps</p>
      {view.attachments.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing wired yet — attach a service to inject{' '}
          <code className="mono-data">{hostVar}</code> and the key secret.
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
                  detach.mutate({ stack: view.stack, name: view.name, appService: a.service })
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
            attach.mutate({ stack: view.stack, name: view.name, appService: candidate })
          }
        >
          <LinkIcon className="size-3.5" /> Attach
        </Button>
      </div>
    </section>
  );
}
