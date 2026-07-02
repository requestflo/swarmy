import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Attach the family's current version to a service: mounts it at the stable
 * mount path (survives edits and rollbacks). The service redeploys once.
 */
export function AttachConfigDialog({ family }: { family: ConfigFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [service, setService] = React.useState('');

  const services = useQuery({ ...trpc.services.list.queryOptions({}), enabled: open });
  const attached = new Set(family.consumers.map((c) => c.serviceName));
  const candidates = (services.data ?? []).filter((s) => !attached.has(s.name));

  const attach = useMutation(
    trpc.configs.attach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.family} mounted into ${r.service} at ${r.mountPath}`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) setService('');
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <LinkIcon className="size-3.5" /> Attach to service
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach {family.family}</DialogTitle>
          <DialogDescription>
            The service restarts once and reads the file from{' '}
            <code className="mono-data">{family.mountPath}</code> — applying new versions swaps the
            content without touching the path.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label className="mono-label">Service</Label>
          <Select value={service || undefined} onValueChange={setService}>
            <SelectTrigger>
              <SelectValue placeholder="Which service reads it?" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((s) => (
                <SelectItem key={s.id} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!services.isLoading && candidates.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Every running service already has this config (or none are deployed yet).
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={() => attach.mutate({ family: family.family, service })}
            disabled={!service || attach.isPending}
          >
            {attach.isPending ? 'Attaching…' : 'Attach & restart'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
