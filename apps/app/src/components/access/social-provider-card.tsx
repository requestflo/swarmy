import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2Icon, GithubIcon, GitlabIcon, ShieldCheckIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, CopyButton, Input, Label, StatusBadge, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PROVIDER_LABELS, enabledTone, type ProviderEntry } from './access-shared';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GithubIcon,
  gitlab: GitlabIcon,
  microsoft: Building2Icon,
};

/** The one non-secret setting some providers take. */
const SETTING: Record<string, { key: string; label: string; placeholder: string; hint: string }> = {
  microsoft: {
    key: 'tenantId',
    label: 'Tenant (optional)',
    placeholder: 'common',
    hint: 'Your Entra ID tenant ID or domain, to accept only your directory. Blank accepts any Microsoft account.',
  },
  gitlab: {
    key: 'issuer',
    label: 'GitLab URL (optional)',
    placeholder: 'https://gitlab.com',
    hint: 'Your self-hosted GitLab, e.g. https://git.example.com. Blank uses gitlab.com.',
  },
};

/** A social OAuth provider: toggle, callback URL, client id/secret (write-only), and its setting. */
export function SocialProviderCard({ provider }: { provider: ProviderEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [clientId, setClientId] = React.useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = React.useState('');
  const settingKey = SETTING[provider.type];
  const [setting, setSetting] = React.useState(settingKey ? (provider.settings?.[settingKey.key] ?? '') : '');
  const [domains, setDomains] = React.useState(provider.settings?.allowedDomains ?? '');

  const save = useMutation(
    trpc.authConfig.setProvider.mutationOptions({
      onSuccess: () => {
        setClientSecret('');
        toast.success(`${PROVIDER_LABELS[provider.type] ?? provider.type} updated`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const Icon = ICONS[provider.type] ?? ShieldCheckIcon;
  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2.5">
          <Icon className="size-5" />
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
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1.5">
          <Label className="mono-label">Callback URL</Label>
          <div className="flex items-center gap-2">
            <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
              {provider.callbackUrl}
            </code>
            <CopyButton value={provider.callbackUrl} label="Copy" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Client ID</Label>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">
            Client secret{' '}
            {provider.hasSecret && <span className="text-status-online">• set</span>}
          </Label>
          <Input
            type="password"
            value={clientSecret}
            placeholder={provider.hasSecret ? '•••••••• (leave blank to keep)' : 'paste secret'}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
        {settingKey && (
          <div className="grid gap-1.5">
            <Label className="mono-label">{settingKey.label}</Label>
            <Input value={setting} placeholder={settingKey.placeholder} onChange={(e) => setSetting(e.target.value)} />
            <p className="text-muted-foreground text-xs">{settingKey.hint}</p>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label className="mono-label">Allowed domains (optional)</Label>
          <Input value={domains} placeholder="company.com, corp.io" onChange={(e) => setDomains(e.target.value)} />
          <p className="text-muted-foreground text-xs">
            Accounts with a verified email at these domains may sign up without an invite and join as members. Blank:
            an invite is required.
          </p>
        </div>
        <Button
          className="w-fit"
          onClick={() =>
            save.mutate({
              type: provider.type,
              clientId,
              clientSecret: clientSecret || undefined,
              settings: { ...(settingKey ? { [settingKey.key]: setting } : {}), allowedDomains: domains },
            })
          }
          disabled={save.isPending}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
