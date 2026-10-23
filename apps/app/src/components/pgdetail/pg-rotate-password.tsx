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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Rotate a database's password (`db.rotatePassword`): a new Docker secret,
 * then the main copy restarts once, the standby copies follow and every
 * wired app redeploys onto it. Confirmed first, because writes pause briefly.
 */
export function PgRotatePassword({ stack, cluster, apps }: { stack: string; cluster: string; apps: string[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const rotate = useMutation(
    trpc.db.rotatePassword.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.cluster} has a new password (v${r.version}) · ${r.redeployed.length} services moved onto it`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const who = apps.length ? apps.join(', ') : 'no app yet';
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={rotate.isPending}>
          {rotate.isPending ? 'Rotating…' : 'Rotate password'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Give {cluster} a new password?</AlertDialogTitle>
          <AlertDialogDescription>
            swarmy makes a new password and keeps it in a new Docker secret. The main copy restarts once, so writes pause
            for a moment; then each standby copy restarts, and every app wired to it redeploys onto the new password ({who}).
            The old password stops working.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-muted-foreground font-mono text-[11.5px]">
          db.rotatePassword · new {stack}_{cluster}-pg-password__v&lt;n+1&gt; · owners and admins (secret.delete) · audited db.password.rotate
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep this password</AlertDialogCancel>
          <AlertDialogAction onClick={() => rotate.mutate({ stack, cluster })}>Rotate password</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
