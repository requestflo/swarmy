import * as React from 'react';
import { Input, Label } from '@swarmy/ui';
import type { SsoProviderEntry } from './access-shared';

interface SsoProviderFieldsProps {
  provider: SsoProviderEntry;
  discoveryUrl: string;
  onDiscoveryUrlChange: (v: string) => void;
  issuer: string;
  onIssuerChange: (v: string) => void;
  domain: string;
  onDomainChange: (v: string) => void;
  clientId: string;
  onClientIdChange: (v: string) => void;
  clientSecret: string;
  onClientSecretChange: (v: string) => void;
}

/** OIDC field grid (or SAML placeholder) for the SSO provider edit form. */
export function SsoProviderFields({
  provider: p,
  discoveryUrl,
  onDiscoveryUrlChange,
  issuer,
  onIssuerChange,
  domain,
  onDomainChange,
  clientId,
  onClientIdChange,
  clientSecret,
  onClientSecretChange,
}: SsoProviderFieldsProps): React.JSX.Element {
  if (p.protocol !== 'oidc') {
    return (
      <p className="text-muted-foreground sm:col-span-2">
        SAML config (IdP metadata XML, SP cert) is stored but not yet wired into sign-in on this
        controller — see release notes.
      </p>
    );
  }

  return (
    <>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label className="mono-label">Discovery URL</Label>
        <Input value={discoveryUrl} onChange={(e) => onDiscoveryUrlChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Issuer (optional)</Label>
        <Input value={issuer} onChange={(e) => onIssuerChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Email domain</Label>
        <Input value={domain} onChange={(e) => onDomainChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Client ID</Label>
        <Input value={clientId} onChange={(e) => onClientIdChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">
          Client secret {p.hasSecret && <span className="text-status-online">• set</span>}
        </Label>
        <Input
          type="password"
          value={clientSecret}
          placeholder={p.hasSecret ? '•••• (keep)' : 'paste secret'}
          onChange={(e) => onClientSecretChange(e.target.value)}
        />
      </div>
    </>
  );
}
