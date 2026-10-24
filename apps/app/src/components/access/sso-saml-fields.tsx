import * as React from 'react';
import { Input, Label, Textarea } from '@swarmy/ui';
import type { SamlFields } from './sso-saml-words';

interface SsoSamlFieldsProps {
  value: SamlFields;
  onChange: (patch: Partial<SamlFields>) => void;
  domain: string;
  onDomainChange: (v: string) => void;
}

/** What the identity provider gives back: its metadata, or entity ID + sign-on URL + certificate. */
export function SsoSamlFields({ value, onChange, domain, onDomainChange }: SsoSamlFieldsProps): React.JSX.Element {
  const fromXml = value.metadataXml.trim() !== '';
  return (
    <>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="saml-idp-metadata">Identity provider metadata (XML)</Label>
        <Textarea
          id="saml-idp-metadata"
          className="mono-data min-h-24 text-xs"
          value={value.metadataXml}
          placeholder={'<md:EntityDescriptor entityID="https://idp.example.com/…">…'}
          onChange={(e) => onChange({ metadataXml: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          Paste it and save: swarmy reads the entity ID, sign-on URL and certificate out of it. Or fill them in below.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="saml-issuer">Entity ID (issuer)</Label>
        <Input
          id="saml-issuer"
          value={value.issuer}
          disabled={fromXml}
          placeholder="https://idp.example.com/saml"
          onChange={(e) => onChange({ issuer: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="saml-domain">Email domain</Label>
        <Input id="saml-domain" value={domain} placeholder="acme.com" onChange={(e) => onDomainChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="saml-entry-point">Sign-on URL (HTTP-Redirect)</Label>
        <Input
          id="saml-entry-point"
          value={value.entryPoint}
          disabled={fromXml}
          placeholder="https://idp.example.com/sso/saml"
          onChange={(e) => onChange({ entryPoint: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="saml-cert">Signing certificate</Label>
        <Textarea
          id="saml-cert"
          className="mono-data min-h-20 text-xs"
          value={value.cert}
          disabled={fromXml}
          placeholder={'-----BEGIN CERTIFICATE-----\nMIIC…'}
          onChange={(e) => onChange({ cert: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          Every assertion must be signed with this certificate. Unsigned ones, and ones signed with any other key, are refused.
        </p>
      </div>
    </>
  );
}
