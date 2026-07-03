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
}: {
  incidentId: string;
  title: string;
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
        <Button className="shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]">
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
