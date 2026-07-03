import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface StackAiGrantedProps {
  stack: string;
  keyName: string;
  createdAt: string;
  attachedServices: { service: string; keyName: string }[];
}

/** The active grant: key row, wired services as flat rows, revoke confirm. */
export function StackAiGranted({
  stack,
  keyName,
  createdAt,
  attachedServices,
}: StackAiGrantedProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const revoke = useMutation(
    trpc.ai.revokeStackAccess.mutationOptions({
      onSuccess: (r) => {
        toast.success(`AI access revoked — ${r.revoked} key${r.revoked === 1 ? '' : 's'} disabled`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="min-w-0">
          <p className="mono-data truncate text-sm">{keyName}</p>
          <p className="text-muted-foreground text-xs">
            Stack key · minted {new Date(createdAt).toLocaleDateString()} · stored as a hash
          </p>
        </div>
        <StatusBadge tone="online" label="active" />
      </div>

      <p className="mono-label mt-3">Wired services</p>
      {attachedServices.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          None yet — the stack key works from anywhere; wire a service to inject gateway env.
        </p>
      ) : (
        <div className="divide-border divide-y">
          {attachedServices.map((s) => (
            <div key={s.service} className="flex items-center justify-between gap-3 py-2">
              <p className="text-sm font-medium">{s.service}</p>
              <p className="mono-data text-muted-foreground text-xs">{s.keyName}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={revoke.isPending}>
              Revoke access
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke AI access for {stack}?</AlertDialogTitle>
              <AlertDialogDescription>
                The stack key and every per-service key are disabled immediately — the gateway
                answers 403 on the next request. Injected env stays until each service redeploys
                (harmless: the keys are dead).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep access</AlertDialogCancel>
              <AlertDialogAction onClick={() => revoke.mutate({ stack })}>Revoke</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
