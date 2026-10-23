import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  toast,
} from '@swarmy/ui';
import { RestartPlanList } from '@/components/app-tabs/variables/restart-plan';
import { useRestartPlan } from '@/components/app-tabs/variables/use-restart-plan';
import { shortName } from '@/components/app-tabs/use-stack-services';
import { useTRPC } from '@/integrations/trpc';
import { SecretValueField } from './secret-value-field';

/**
 * Rotate confirm (AlertDialog — it restarts every consumer): new write-only
 * value + the restart plan, read from each consumer's live spec: copies and
 * how they roll ("2 copies · one at a time", "starts new before stopping old").
 */
export function RotateSecretAlert({ family }: { family: SecretFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const consumers = React.useMemo(
    () => family.consumers.map((c) => ({ id: c.serviceId, name: shortName(c.stack, c.serviceName) })),
    [family.consumers],
  );
  const plan = useRestartPlan(consumers, open);

  const rotate = useMutation(
    trpc.secrets.rotate.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.redeployed.length > 0
            ? `${r.family} rotated to v${r.version} — ${r.redeployed.length} service(s) restarting`
            : `${r.family} rotated to v${r.version}`,
        );
        setOpen(false);
        setValue('');
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
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11">
          <RefreshCwIcon className="size-3.5" /> Rotate
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rotate {family.family}?</AlertDialogTitle>
          <AlertDialogDescription>
            Paste the new value. swarmy writes it as{' '}
            <span className="mono-data">v{family.currentVersion + 1}</span> of the Docker secret and restarts the
            services that read it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <SecretValueField value={value} onChange={setValue} label="New value" />
        <RestartPlanList plan={plan} note="the old version stays until you prune it" />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={value.length === 0 || rotate.isPending}
            onClick={(e) => {
              e.preventDefault();
              rotate.mutate({ family: family.family, value });
            }}
          >
            {rotate.isPending ? 'Rotating…' : `Rotate to v${family.currentVersion + 1}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
