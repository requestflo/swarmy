import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { MailIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useEmailMutationHandlers } from './use-email';

/** Service off: what turning it on does, and the one coral CTA. */
export function EmailOffCard({ vaultReady }: { vaultReady: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const enable = useMutation(trpc.email.setEnabled.mutationOptions(useEmailMutationHandlers('Email service is starting')));
  return (
    <div className="ink-block rounded-2xl p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-2xl space-y-3">
          <span className="bg-primary/15 text-primary inline-flex size-10 items-center justify-center rounded-xl">
            <MailIcon className="size-5" />
          </span>
          <p className="text-xl font-bold">Turn on the email service</p>
          <ul className="text-ink-foreground/80 list-disc space-y-1 pl-5 text-sm">
            <li>Runs a small mail server (maddy, ~30 MB of memory) on one of your nodes.</li>
            <li>Apps send over SMTP or the HTTP API, each with its own login and key.</li>
            <li>swarmy publishes SPF, DKIM and DMARC for domains on swarmy DNS, and shows the exact records for the rest.</li>
            <li>Invites, sign-up email checks and alerts start going out by email.</li>
          </ul>
          {!vaultReady ? (
            <p className="text-status-warning text-sm">
              Set <code className="mono-data">SWARMY_SECRET_KEY</code> on the controller first: DKIM keys and credentials are encrypted with it.
            </p>
          ) : null}
        </div>
        <Button
          className="shadow-[0_8px_24px_-8px_var(--primary)] hover:scale-[1.03]"
          disabled={!vaultReady || enable.isPending}
          onClick={() => enable.mutate({ enabled: true })}
        >
          {enable.isPending ? 'Starting…' : 'Turn on email'}
        </Button>
      </div>
    </div>
  );
}
