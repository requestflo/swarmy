import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DeliveryFields, emptyRelay, relayInput, type RelayDraft } from './delivery-fields';
import { useEmailMutationHandlers } from './use-email';

/** The page's coral CTA once email is on: add a sending domain. */
export function AddDomainDialog(): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [domain, setDomain] = React.useState('');
  const [delivery, setDelivery] = React.useState<'direct' | 'relay'>('direct');
  const [relay, setRelay] = React.useState<RelayDraft>(emptyRelay);
  const handlers = useEmailMutationHandlers('Domain added — publish its records next');
  const add = useMutation(
    trpc.email.addDomain.mutationOptions({
      ...handlers,
      onSuccess: () => {
        handlers.onSuccess();
        setOpen(false);
        setDomain('');
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="shadow-[0_8px_24px_-8px_var(--primary)] hover:scale-[1.03]">
          <PlusIcon className="size-4" /> Add domain
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a sending domain</DialogTitle>
          <DialogDescription>swarmy creates a DKIM key for it and shows the DNS records to publish.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ domain, delivery, relay: delivery === 'relay' ? relayInput(relay) : null });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="email-domain">Domain</Label>
            <Input id="email-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required />
          </div>
          <DeliveryFields delivery={delivery} onDelivery={setDelivery} relay={relay} onRelay={setRelay} />
          <DialogFooter>
            <Button variant="outline" type="submit" disabled={add.isPending || !domain}>
              {add.isPending ? 'Adding…' : 'Add domain'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
