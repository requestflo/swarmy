import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Acknowledge one firing alert (resolves the event). Quiet by default; `primary` for the page's one action. */
export function AckButton({
  id,
  label = 'Ack',
  primary,
  size = 'sm',
}: {
  id: string;
  label?: string;
  primary?: boolean;
  size?: 'sm' | 'default';
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ack = useMutation(
    trpc.alerts.ack.mutationOptions({
      onSuccess: () => {
        toast.success('Acknowledged. The alert is resolved.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Button
      size={size}
      variant={primary ? 'default' : 'ghost'}
      className="pointer-coarse:min-h-11"
      disabled={ack.isPending}
      onClick={() => ack.mutate({ id })}
    >
      <CheckIcon className="size-3.5" /> {ack.isPending ? 'Acknowledging…' : label}
    </Button>
  );
}
