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
  /** The new provider's id (the tab opens it: a SAML one shows its IdP URLs there). */
  onCreated?: (id: string) => void;
}

/** Inline expanding card (no modal): new OIDC/SAML SSO provider. */
export function SsoCreateCard({ open, onOpenChange, onCreated }: SsoCreateCardProps): React.JSX.Element {
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
      onSuccess: (saved) => {
        toast.success('SSO provider saved');
        onCreated?.(saved.id);
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
              OIDC via discovery URL, or SAML. Once saved, the provider shows the URLs your IdP needs.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label>Provider slug</Label>
            <Input aria-label="Provider slug" value={providerId} placeholder="acme" onChange={(e) => setProviderId(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Protocol</Label>
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
              <Label>Email domain</Label>
              <Input aria-label="Email domain" value={domain} placeholder="acme.com" onChange={(e) => setDomain(e.target.value)} />
            </div>
          </div>
          {protocol === 'oidc' ? (
            <>
              <div className="grid gap-1.5">
                <Label>Discovery URL</Label>
                <Input aria-label="Discovery URL"
                  value={discoveryUrl}
                  placeholder="https://idp.acme.com/.well-known/openid-configuration"
                  onChange={(e) => setDiscoveryUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Issuer (optional)</Label>
                <Input aria-label="Issuer (optional)" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Client ID</Label>
                  <Input aria-label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Client secret</Label>
                  <Input aria-label="Client secret"
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
              Create it, then give your identity provider the entity ID and ACS URL it shows, and
              paste the IdP&rsquo;s metadata back into it.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
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
