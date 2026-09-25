import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { SendIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { emailErrorToast } from './use-email';

/** Send a short test message through the real path (MTA, DKIM, route). */
export function TestSendDialog({ domains }: { domains: string[] }): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  React.useEffect(() => {
    if (!from && domains[0]) setFrom(`test@${domains[0]}`);
  }, [domains, from]);
  const send = useMutation(
    trpc.email.testSend.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Queued ${r.messageId}. Check the inbox (and spam) — the send log shows delivery.`);
        setOpen(false);
      },
      onError: emailErrorToast,
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={domains.length === 0} title={domains.length ? undefined : 'Verify a domain first'}>
          <SendIcon className="size-4" /> Test send
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test email</DialogTitle>
          <DialogDescription>Goes out through the mail server with your domain’s DKIM signature, exactly like app mail.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate({ from, to });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="test-from">From</Label>
            <Input id="test-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={`test@${domains[0] ?? 'example.com'}`} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="test-to">To</Label>
            <Input id="test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" required />
          </div>
          <DialogFooter>
            <Button variant="outline" type="submit" disabled={send.isPending || !to || !from}>
              {send.isPending ? 'Sending…' : 'Send test'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
