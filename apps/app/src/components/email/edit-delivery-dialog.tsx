import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DeliveryFields, emptyRelay, relayInput, type RelayDraft } from './delivery-fields';
import { useEmailMutationHandlers, type EmailDomainData } from './use-email';

interface Props {
  domain: EmailDomainData;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

/** Switch a domain between direct delivery and a smarthost relay. */
export function EditDeliveryDialog({ domain: d, open, onOpenChange }: Props): React.JSX.Element {
  const trpc = useTRPC();
  const [delivery, setDelivery] = React.useState(d.delivery);
  const [relay, setRelay] = React.useState<RelayDraft>(
    d.relay
      ? { host: d.relay.host, port: String(d.relay.port), security: d.relay.security, username: d.relay.username ?? '', password: '', spfInclude: d.relay.spfInclude ?? '' }
      : emptyRelay,
  );
  const handlers = useEmailMutationHandlers('Delivery updated');
  const save = useMutation(
    trpc.email.updateDomain.mutationOptions({
      ...handlers,
      onSuccess: () => {
        handlers.onSuccess();
        onOpenChange(false);
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delivery for {d.domain}</DialogTitle>
          <DialogDescription>The SPF record changes with it — republish it (swarmy DNS does this for you).</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ id: d.id, delivery, relay: delivery === 'relay' ? relayInput(relay) : null });
          }}
        >
          <DeliveryFields delivery={delivery} onDelivery={setDelivery} relay={relay} onRelay={setRelay} passwordSet={d.relay?.passwordSet} />
          <DialogFooter>
            <Button variant="outline" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
