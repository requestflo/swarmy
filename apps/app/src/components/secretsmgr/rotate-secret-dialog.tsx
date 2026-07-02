import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SecretValueField } from './secret-value-field';

/**
 * Rotate = new version + every consumer redeployed onto it. The dialog is
 * explicit about which services will restart before you commit.
 */
export function RotateSecretDialog({ family }: { family: SecretFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');

  const rotate = useMutation(
    trpc.secrets.rotate.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.redeployed.length > 0
            ? `${r.family} rotated to v${r.version} — ${r.redeployed.length} service(s) restarting`
            : `${r.family} rotated to v${r.version}`,
        );
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) setValue('');
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">
          <RefreshCwIcon className="size-3.5" /> Rotate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate {family.family}</DialogTitle>
          <DialogDescription>
            Creates <span className="mono-data">v{family.currentVersion + 1}</span> and moves every
            consumer onto it. The old version is kept until you prune it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SecretValueField value={value} onChange={setValue} label="New value" />
          {family.consumers.length > 0 ? (
            <div className="bg-status-warning/10 text-status-warning flex gap-2.5 rounded-xl p-3 text-xs">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-semibold">
                  {family.consumers.length} service{family.consumers.length === 1 ? '' : 's'} will
                  restart to pick up the new value:
                </p>
                <p className="mono-data mt-1 break-words">
                  {family.consumers.map((c) => c.serviceName).join(', ')}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No services use this secret yet — nothing will restart.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => rotate.mutate({ family: family.family, value })}
            disabled={value.length === 0 || rotate.isPending}
          >
            {rotate.isPending ? 'Rotating…' : `Rotate to v${family.currentVersion + 1}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
