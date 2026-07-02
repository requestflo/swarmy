import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotifyConfigView, NotifyProviderView } from '@swarmy/core';
import { NOTIFY_PROVIDERS } from '@swarmy/core';
import { Button, CopyButton, Input, Label, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EMPTY_FIELDS, type ProviderFormFields } from './form-state';
import { ProviderFields } from './provider-fields';
import { buildSetConfigInput, hydrateFields } from './provider-form';
import { TestSendRow } from './test-send-row';

const PROVIDER_LABEL: Record<NotifyProviderView, string> = {
  smtp: 'SMTP',
  resend: 'Resend',
  postmark: 'Postmark',
  mailgun: 'Mailgun',
};

/** Provider picker + credentials + from-address + save + test send. */
export function ProviderCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.notifications.getConfig.queryOptions());

  const [provider, setProvider] = React.useState<NotifyProviderView>('smtp');
  const [fromAddress, setFromAddress] = React.useState('');
  const [fields, setFields] = React.useState<ProviderFormFields>(EMPTY_FIELDS);
  const hydratedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    const data = config.data;
    if (!data || hydratedFor.current === data.updatedAt) return;
    hydratedFor.current = data.updatedAt;
    setProvider(data.provider);
    setFromAddress(data.fromAddress ?? '');
    setFields(hydrateFields(data));
  }, [config.data]);

  const save = useMutation(
    trpc.notifications.setConfig.mutationOptions({
      onSuccess: () => {
        toast.success('Provider saved — send yourself a test email.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const set = <K extends keyof ProviderFormFields>(key: K, value: ProviderFormFields[K]): void =>
    setFields((f) => ({ ...f, [key]: value }));

  if (config.isLoading) {
    return (
      <section className="card-pop space-y-3 p-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shimmer-line h-9 rounded-lg" />
        ))}
      </section>
    );
  }
  if (config.isError) {
    return (
      <section className="card-pop text-muted-foreground flex items-center justify-between gap-3 p-6 text-sm">
        <span>Couldn't load the provider config — {config.error.message}</span>
        <Button variant="outline" size="sm" onClick={() => void config.refetch()}>
          Retry
        </Button>
      </section>
    );
  }

  const current: NotifyConfigView | undefined = config.data;
  const sameProviderConfigured = Boolean(current?.configured && current.provider === provider);
  const input = buildSetConfigInput(provider, fromAddress, fields, sameProviderConfigured);

  return (
    <section className="card-pop p-6">
      <h2 className="font-display text-lg font-bold">Email provider</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Credentials are encrypted at rest and never shown again.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {NOTIFY_PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setProvider(p)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
              provider === p
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {PROVIDER_LABEL[p]}
            {current?.configured && current.provider === p ? ' ·' : ''}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="np-from">From address</Label>
          <Input
            id="np-from"
            type="email"
            placeholder="swarmy@yourdomain.dev"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
          />
        </div>
        <ProviderFields
          provider={provider}
          fields={fields}
          set={set}
          configured={sameProviderConfigured}
        />
      </div>

      <div className="mt-5 flex items-center justify-end">
        <Button disabled={!input || save.isPending} onClick={() => input && save.mutate(input)}>
          {save.isPending ? 'Saving…' : 'Save provider'}
        </Button>
      </div>

      {current?.bounceEndpointUrl ? (
        <div className="border-border mt-5 border-t pt-4">
          <div className="mono-label text-muted-foreground">Bounce webhook</div>
          <p className="text-muted-foreground mt-1 text-xs">
            Point your provider's bounce/complaint webhook here — bounced mail shows up in the
            delivery log automatically.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-accent min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs">
              {current.bounceEndpointUrl}
            </code>
            <CopyButton value={current.bounceEndpointUrl} />
          </div>
        </div>
      ) : null}

      {current?.configured ? <TestSendRow /> : null}
    </section>
  );
}
