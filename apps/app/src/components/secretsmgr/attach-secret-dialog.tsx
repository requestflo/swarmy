import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Attach the family's current version to a service: mounts it at the stable
 * `/run/secrets/<family>` path (survives rotations) and can point an env var
 * at that path. The service redeploys to pick it up.
 */
export function AttachSecretDialog({ family }: { family: SecretFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [service, setService] = React.useState('');
  const [envName, setEnvName] = React.useState('');

  const services = useQuery({ ...trpc.services.list.queryOptions({}), enabled: open });
  const attached = new Set(family.consumers.map((c) => c.serviceName));
  const candidates = (services.data ?? []).filter((s) => !attached.has(s.name));

  const attach = useMutation(
    trpc.secrets.attach.mutationOptions({
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
    if (!next) {
      setService('');
      setEnvName('');
    }
  };

  const envOk = envName.trim() === '' || ENV_RE.test(envName.trim());

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
            The service restarts once and reads the value from{' '}
            <code className="mono-data">/run/secrets/{family.family}</code> — rotations swap the
            value without touching the path.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Service</Label>
            <Select value={service || undefined} onValueChange={setService}>
              <SelectTrigger>
                <SelectValue placeholder="Which service needs it?" />
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
                Every running service already has this secret (or none are deployed yet).
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Env var (optional)</Label>
            <Input
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
              placeholder={`${family.family}_FILE`}
              className="mono-data"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Set to the mount path so your app knows where to read the file from.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              attach.mutate({
                family: family.family,
                service,
                ...(envName.trim() ? { envName: envName.trim() } : {}),
              })
            }
            disabled={!service || !envOk || attach.isPending}
          >
            {attach.isPending ? 'Attaching…' : 'Attach & restart'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
