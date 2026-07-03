import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SecretRevealBanner } from './secret-reveal-banner';

/**
 * Register an outbound endpoint (admin): swarmy's own events pushed to your
 * URL, signed. The signing secret (`whsec_…`) is revealed once, inline.
 */
export function RegisterOutboundInline({ onDone }: { onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState('*');
  const [secret, setSecret] = React.useState<string | null>(null);

  const register = useMutation(
    trpc.webhooksOut.register.mutationOptions({
      onSuccess: (e) => {
        setSecret(e.secret);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const eventList = events
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const ready = /^https?:\/\/.+/.test(url) && eventList.length > 0;

  if (secret) {
    return (
      <SecretRevealBanner
        title="Endpoint registered — signing secret shown once"
        description="Verify deliveries with the X-Swarmy-Signature header (HMAC-SHA256 of the raw body)."
        secret={secret}
        onDismiss={() => {
          setSecret(null);
          setUrl('');
          setEvents('*');
          onDone();
        }}
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="mono-label">URL</Label>
        <Input
          value={url}
          placeholder="https://ops.example.com/hooks/swarmy"
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Events (comma-separated, * for all)</Label>
        <Input value={events} placeholder="*" onChange={(e) => setEvents(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!ready || register.isPending}
          onClick={() => register.mutate({ url: url.trim(), events: eventList })}
        >
          {register.isPending ? 'Registering…' : 'Register'}
        </Button>
      </div>
    </div>
  );
}
