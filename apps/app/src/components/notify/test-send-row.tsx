import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SendIcon } from 'lucide-react';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** "Send a test email" — proves the saved provider config end-to-end. */
export function TestSendRow(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [to, setTo] = React.useState('');

  const test = useMutation(
    trpc.notifications.testSend.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Test email queued for ${r.to} — watch the delivery log below.`);
        setTo('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

  return (
    <div className="border-border mt-5 border-t pt-4">
      <div className="mono-label text-muted-foreground">Send a test email</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          type="email"
          placeholder="you@yourteam.dev"
          className="min-w-0 flex-1"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && !test.isPending) test.mutate({ to: to.trim() });
          }}
        />
        <Button
          variant="outline"
          disabled={!valid || test.isPending}
          onClick={() => test.mutate({ to: to.trim() })}
        >
          <SendIcon className="size-4" />
          {test.isPending ? 'Queueing…' : 'Send test'}
        </Button>
      </div>
    </div>
  );
}
