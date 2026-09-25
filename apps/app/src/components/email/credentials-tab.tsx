import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EmptyState } from '@/components/states';
import { CreateCredentialDialog } from './create-credential-dialog';
import { CredentialReveal, type RevealedCredential } from './credential-reveal';
import { emailErrorToast, useEmailMutationHandlers, type EmailOverviewData } from './use-email';

/** Per-app sending credentials: an SMTP login + an HTTP API key each. */
export function CredentialsTab({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  const trpc = useTRPC();
  const [revealed, setRevealed] = React.useState<RevealedCredential | null>(null);
  const reveal = useMutation(
    trpc.email.revealCredential.mutationOptions({
      onSuccess: (r) => setRevealed({ smtpHost: o.mta.host, smtpPort: o.mta.port, username: r.username, password: r.password, apiKey: r.apiKey, apiUrl: o.apiUrl, webhookSecret: null }),
      onError: emailErrorToast,
    }),
  );
  const update = useMutation(trpc.email.updateCredential.mutationOptions(useEmailMutationHandlers('Saved')));
  const remove = useMutation(trpc.email.removeCredential.mutationOptions(useEmailMutationHandlers('Credential removed')));
  return (
    <div className="calm-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Credentials</p>
          <p className="text-muted-foreground text-xs">
            Apps with <code className="mono-data">email:</code> in swarmy.yaml get one automatically (SMTP_* and EMAIL_API_* bound as Docker secrets). Make one here for anything else.
          </p>
        </div>
        <CreateCredentialDialog domains={o.domains.map((d) => d.domain)} onCreated={setRevealed} apiUrl={o.apiUrl} />
      </div>
      {revealed ? (
        <div className="mt-4">
          <CredentialReveal credential={revealed} onDismiss={() => setRevealed(null)} />
        </div>
      ) : null}
      {o.credentials.length === 0 ? (
        <EmptyState icon={<KeyRoundIcon />} title="No credentials yet — create one." description="Each app gets its own login, so you can see who sent what and revoke one without touching the rest." />
      ) : (
        <div className="border-border divide-border mt-4 divide-y rounded-xl border">
          {o.credentials.map((c) => (
            <div key={c.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${c.disabled ? 'opacity-50' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {c.name} {c.stack ? <span className="text-muted-foreground text-xs">→ app {c.stack}</span> : null}
                  {c.system ? <span className="text-muted-foreground text-xs"> · swarmy’s own mail</span> : null}
                </p>
                <p className="mono-data text-muted-foreground truncate text-xs">
                  {c.smtpUsername} · {c.apiKeyPrefix}… · {c.domains.length ? c.domains.join(', ') : 'any verified domain'}
                  {c.webhookUrl ? ` · webhook ${new URL(c.webhookUrl).host}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate({ id: c.id })}>
                  Reveal
                </Button>
                {!c.system ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => update.mutate({ id: c.id, disabled: !c.disabled })}>
                      {c.disabled ? 'Enable' : 'Disable'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-tone-bad"
                      onClick={() => {
                        if (window.confirm(`Remove ${c.name}? Apps using it stop sending.`)) remove.mutate({ id: c.id });
                      }}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
