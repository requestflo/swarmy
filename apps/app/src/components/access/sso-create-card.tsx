import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface SsoCreateCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding card (no modal): new OIDC/SAML SSO provider. */
export function SsoCreateCard({ open, onOpenChange }: SsoCreateCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [providerId, setProviderId] = React.useState('');
  const [protocol, setProtocol] = React.useState<'oidc' | 'saml'>('oidc');
  const [domain, setDomain] = React.useState('');
  const [issuer, setIssuer] = React.useState('');
  const [discoveryUrl, setDiscoveryUrl] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');

  const upsert = useMutation(
    trpc.sso.upsert.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider saved');
        setProviderId('');
        setDomain('');
        setIssuer('');
        setDiscoveryUrl('');
        setClientId('');
        setClientSecret('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">New SSO provider</p>
            <p className="text-muted-foreground text-xs">
              OIDC via discovery URL. Paste the callback URL into your IdP once saved.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Provider slug</Label>
            <Input value={providerId} placeholder="acme" onChange={(e) => setProviderId(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="mono-label">Protocol</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as 'oidc' | 'saml')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="saml">SAML</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Email domain</Label>
              <Input value={domain} placeholder="acme.com" onChange={(e) => setDomain(e.target.value)} />
            </div>
          </div>
          {protocol === 'oidc' ? (
            <>
              <div className="grid gap-1.5">
                <Label className="mono-label">Discovery URL</Label>
                <Input
                  value={discoveryUrl}
                  placeholder="https://idp.acme.com/.well-known/openid-configuration"
                  onChange={(e) => setDiscoveryUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="mono-label">Issuer (optional)</Label>
                <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="mono-label">Client ID</Label>
                  <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="mono-label">Client secret</Label>
                  <Input
                    type="password"
                    value={clientSecret}
                    placeholder="paste secret"
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              SAML config (IdP metadata XML, SP cert) is stored but not yet wired into sign-in on
              this controller — see release notes.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={upsert.isPending || !providerId}
              onClick={() =>
                upsert.mutate({
                  providerId,
                  protocol,
                  domain: domain || null,
                  issuer: issuer || null,
                  clientId: clientId || null,
                  clientSecret: clientSecret || undefined,
                  metadata: discoveryUrl ? { discoveryUrl } : {},
                })
              }
            >
              {upsert.isPending ? 'Saving…' : 'Create provider'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
