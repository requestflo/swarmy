import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { Badge, Button, Collapsible, CollapsibleContent, CopyButton, Label, StatusBadge, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { enabledTone, type SsoProviderEntry } from './access-shared';
import { SsoDeleteButton } from './sso-delete-button';
import { SsoProviderFields } from './sso-provider-fields';
import { SsoProvisioningFields } from './sso-provisioning-fields';
import { SsoSamlFields } from './sso-saml-fields';
import { SsoSamlSetup } from './sso-saml-setup';
import { useSamlFields } from './use-saml-fields';
import { useSsoProvisioning } from './use-sso-provisioning';

interface SsoProviderRowProps {
  provider: SsoProviderEntry;
  expanded: boolean;
  onToggle: () => void;
}

/** One SSO provider row; Edit expands the upsert form + the IdP-facing URLs + delete inline. */
export function SsoProviderRow({ provider: p, expanded, onToggle }: SsoProviderRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const saml = p.protocol === 'saml';
  const [domain, setDomain] = React.useState(p.domain ?? '');
  const [issuer, setIssuer] = React.useState(p.issuer ?? '');
  const [discoveryUrl, setDiscoveryUrl] = React.useState((p.metadata?.discoveryUrl as string) ?? '');
  const [clientId, setClientId] = React.useState(p.clientId ?? '');
  const [clientSecret, setClientSecret] = React.useState('');
  const provisioning = useSsoProvisioning(p);
  const samlFields = useSamlFields(p);

  const upsert = useMutation(
    trpc.sso.upsert.mutationOptions({
      onSuccess: (saved) => {
        toast.success('SSO provider saved');
        if (saml) samlFields.reset(saved as SsoProviderEntry);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function save(): void {
    const patch = provisioning.toPatch();
    const idp = saml ? samlFields.toPatch() : null;
    upsert.mutate({
      id: p.id,
      providerId: p.providerId,
      protocol: p.protocol,
      domain: domain || null,
      issuer: idp ? idp.issuer : issuer || null,
      clientId: saml ? null : clientId || null,
      clientSecret: saml ? undefined : clientSecret || undefined,
      // Merge: keep endpoints/scopes the form doesn't show.
      metadata: { ...p.metadata, ...patch.metadata, ...(idp?.metadata ?? (discoveryUrl ? { discoveryUrl } : {})) },
      mapping: patch.mapping,
    });
  }

  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/60 grid w-full grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 text-left transition-colors sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]"
      >
        <div className="min-w-0">
          <p className="truncate font-medium">{p.providerId}</p>
          <p className="text-muted-foreground mono-label truncate sm:hidden">
            {p.protocol.toUpperCase()} · {p.domain ?? 'no domain'}
          </p>
        </div>
        <Badge variant="muted" className="hidden sm:inline-flex">
          {p.protocol.toUpperCase()}
        </Badge>
        <span className="mono-data hidden truncate sm:block">{p.domain ?? '—'}</span>
        <span className="hidden sm:block">
          <StatusBadge
            tone={enabledTone(p.enabled && (!saml || Boolean(p.saml?.ready)))}
            label={!p.enabled ? 'disabled' : saml && !p.saml?.ready ? 'needs IdP' : 'enabled'}
          />
        </span>
        <ChevronDownIcon className={cn('size-4 justify-self-end transition-transform', expanded && 'rotate-180')} />
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <div className="space-y-4 px-6 pb-6">
            {saml && <SsoSamlSetup provider={p} />}
            <div className="grid gap-3 sm:grid-cols-2">
              {saml ? (
                <SsoSamlFields value={samlFields.value} onChange={samlFields.set} domain={domain} onDomainChange={setDomain} />
              ) : (
                <SsoProviderFields
                  provider={p}
                  discoveryUrl={discoveryUrl}
                  onDiscoveryUrlChange={setDiscoveryUrl}
                  issuer={issuer}
                  onIssuerChange={setIssuer}
                  domain={domain}
                  onDomainChange={setDomain}
                  clientId={clientId}
                  onClientIdChange={setClientId}
                  clientSecret={clientSecret}
                  onClientSecretChange={setClientSecret}
                />
              )}
            </div>
            <SsoProvisioningFields value={provisioning.value} onChange={provisioning.set} saml={saml} />
            {!saml && (
              <div className="grid gap-1.5">
                <Label>Callback URL (paste into IdP)</Label>
                <div className="flex items-center gap-2">
                  <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">{p.callbackUrl}</code>
                  <CopyButton value={p.callbackUrl} label="Copy" />
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" disabled={upsert.isPending} onClick={save}>
                {upsert.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <SsoDeleteButton id={p.id} providerId={p.providerId} />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
