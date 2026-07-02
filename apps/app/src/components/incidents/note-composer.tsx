import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SendIcon } from 'lucide-react';
import { Button, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Post-mortem notes composer — appends a manual `note` timeline event. */
export function NoteComposer({ incidentId }: { incidentId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [message, setMessage] = React.useState('');

  const addNote = useMutation(
    trpc.incidents.addNote.mutationOptions({
      onSuccess: () => {
        setMessage('');
        toast.success('Note added to the timeline.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    const trimmed = message.trim();
    if (!trimmed) return;
    addNote.mutate({ id: incidentId, message: trimmed });
  };

  return (
    <div className="grid gap-2">
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a note — what you found, what you changed, what to do next time…"
        rows={3}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
        }}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={!message.trim() || addNote.isPending}
          onClick={submit}
        >
          <SendIcon className="size-4" />
          {addNote.isPending ? 'Adding…' : 'Add note'}
        </Button>
      </div>
    </div>
  );
}
