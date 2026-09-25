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
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { STEP_TEXT, type PlatformAvailable } from './use-platform';

/** The Upgrade button: the order it goes in, then platform.start (the existing mutation). */
export function UpgradeDialog({ av }: { av: PlatformAvailable }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [skipBackup, setSkipBackup] = React.useState(false);
  const start = useMutation(
    trpc.platform.start.mutationOptions({
      onSuccess: () => {
        toast.success('Upgrade started');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button className="pointer-coarse:min-h-11" disabled={Boolean(av.blocked) || start.isPending}>
          Upgrade to {av.version}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Upgrade to {av.version}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2 text-sm">
              <p>In this order, each piece health-checked and put back on its own if it fails:</p>
              <ol className="list-decimal space-y-1 pl-5">
                {Object.keys(STEP_TEXT).map((k) => (
                  <li key={k}>
                    <b>{STEP_TEXT[k]!.name}</b>: {STEP_TEXT[k]!.what}
                  </li>
                ))}
              </ol>
              {av.migrations.map((m) => (
                <p key={m.id} className="text-tone-warn">{m.note}</p>
              ))}
              <p>Apps keep serving throughout; the dashboard is away for about a minute while swarmy restarts itself.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2">
          <QuietSwitch id="skip-backup" checked={skipBackup} onCheckedChange={setSkipBackup} />
          <Label htmlFor="skip-backup" className="text-xs">Upgrade without a fresh controller backup (not recommended)</Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={() => start.mutate({ version: av.version, skipBackup })}>Start upgrade</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
