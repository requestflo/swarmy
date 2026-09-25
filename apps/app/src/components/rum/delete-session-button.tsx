import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface DeleteSessionButtonProps {
  stack: string;
  sessionId: string;
}

/**
 * GDPR: erase this one session (recording, replay index, its analytics rows).
 * Confirms in place — two clicks, no browser dialog.
 */
export function DeleteSessionButton({ stack, sessionId }: DeleteSessionButtonProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = React.useState(false);
  const del = useMutation(
    trpc.rum.deleteSession.mutationOptions({
      onSuccess: () => {
        toast.success('Session deleted — recording, index and its analytics rows are gone');
        void qc.invalidateQueries({ queryKey: trpc.rum.replays.queryKey() });
        void navigate({ to: '/stacks/$name/replays', params: { name: stack } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="border-status-offline/40 text-tone-bad rounded-full font-bold"
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon className="size-3.5" /> Delete session
      </Button>
    );
  }
  return (
    <span role="alert" className="border-status-offline/40 flex items-center gap-2 rounded-full border py-0.5 pr-0.5 pl-3 text-xs">
      <span className="font-semibold">Delete this session for good?</span>
      <Button
        size="sm"
        variant="outline"
        className="border-status-offline text-tone-bad h-7 rounded-full font-bold"
        disabled={del.isPending}
        onClick={() => del.mutate({ stack, sessionId })}
      >
        {del.isPending ? 'Deleting…' : 'Delete'}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 rounded-full" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}
