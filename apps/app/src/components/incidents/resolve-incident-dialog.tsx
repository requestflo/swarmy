import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon } from 'lucide-react';
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
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Confirmed manual resolve: flips status + writes the final timeline event. */
export function ResolveIncidentDialog({
  incidentId,
  title,
  quiet,
}: {
  incidentId: string;
  title: string;
  /** Outline when another action (a put-back) is the page's one coral. */
  quiet?: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const resolve = useMutation(
    trpc.incidents.resolve.mutationOptions({
      onSuccess: () => {
        toast.success('Incident resolved.');
        setOpen(false);
        setMessage('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={quiet ? 'outline' : 'default'} className="pointer-coarse:min-h-11">
          <CheckCircle2Icon className="size-4" /> Resolve incident
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resolve this incident?</AlertDialogTitle>
          <AlertDialogDescription>
            Marks “{title}” resolved and writes a final event on the timeline. You can reopen it if
            it flares up again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Resolution message (optional) — e.g. “Replica promoted, cluster healthy.”"
          rows={3}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={resolve.isPending}
            onClick={(e) => {
              e.preventDefault();
              resolve.mutate({ id: incidentId, message: message.trim() || undefined });
            }}
          >
            {resolve.isPending ? 'Resolving…' : 'Resolve'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
