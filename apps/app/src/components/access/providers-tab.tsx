import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, MailIcon, ShieldIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, StatusBadge, Switch, toast } from '@swarmy/ui';
import { authClient } from '@swarmy/auth/client';
import { useTRPC } from '@/integrations/trpc';
import {
  PROVIDER_LABELS,
  enabledTone,
  type ProviderEntry,
} from '@/components/access/access-shared';
import { SocialProviderCard } from './social-provider-card';

/**
 * Sign-in tab: social providers (Microsoft, Google, GitHub, GitLab) + passwordless
 * methods. Generic OIDC (Keycloak, Authentik, Zitadel…) lives on the SSO tab.
 * Username + password is always on.
 */
export function ProvidersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const providers = useQuery(trpc.authConfig.listProviders.queryOptions());
  const social = (providers.data ?? []).filter((p) => p.kind === 'social');
  const methods = (providers.data ?? []).filter((p) => p.kind === 'method');

  if (providers.data?.length === 0) {
    return (
      <EmptyState
        icon={<ShieldIcon />}
        title="No providers available"
        description="This controller exposes no sign-in providers. Configure them on the API host to light up social and passwordless login."
      />
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {social.map((p) => (
          <SocialProviderCard key={p.type} provider={p as ProviderEntry} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {methods.map((p) => (
          <MethodCard key={p.type} provider={p as ProviderEntry} />
        ))}
      </div>
    </div>
  );
}

function MethodCard({ provider }: { provider: ProviderEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const save = useMutation(
    trpc.authConfig.setProvider.mutationOptions({
      onSuccess: () => {
        toast.success(`${PROVIDER_LABELS[provider.type] ?? provider.type} updated`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const isPasskey = provider.type === 'passkey';

  const enrollPasskey = async (): Promise<void> => {
    try {
      // Requires the passkey client plugin (see INTEGRATION). Guarded so the UI
      // degrades gracefully when the plugin is absent.
      const client = authClient as unknown as {
        passkey?: { addPasskey: () => Promise<unknown> };
      };
      if (!client.passkey?.addPasskey) {
        toast.error('Passkey plugin not installed on this controller');
        return;
      }
      await client.passkey.addPasskey();
      toast.success('Passkey registered');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Passkey enrolment failed');
    }
  };

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2.5">
          {isPasskey ? <KeyRoundIcon className="size-5" /> : <MailIcon className="size-5" />}
          <CardTitle className="text-base">
            {PROVIDER_LABELS[provider.type] ?? provider.type}
          </CardTitle>
          <StatusBadge
            tone={enabledTone(provider.enabled)}
            label={provider.enabled ? 'on' : 'off'}
          />
        </div>
        <Switch
          checked={provider.enabled}
          onCheckedChange={(enabled) => save.mutate({ type: provider.type, enabled })}
          disabled={save.isPending}
        />
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          {isPasskey
            ? 'Passwordless WebAuthn sign-in. No secret to configure.'
            : 'Email a one-time sign-in link. Needs a configured email sender.'}
        </p>
        {isPasskey && provider.enabled && (
          <Button variant="outline" className="w-fit" onClick={() => void enrollPasskey()}>
            Register a passkey
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
