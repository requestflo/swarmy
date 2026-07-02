import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]">
          <CheckCircle2Icon className="size-4" /> Resolve incident
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve this incident?</DialogTitle>
          <DialogDescription>
            Marks “{title}” resolved and writes a final event on the timeline. You can reopen it if
            it flares up again.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Resolution message (optional) — e.g. “Replica promoted, cluster healthy.”"
          rows={3}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({ id: incidentId, message: message.trim() || undefined })
            }
          >
            {resolve.isPending ? 'Resolving…' : 'Resolve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
