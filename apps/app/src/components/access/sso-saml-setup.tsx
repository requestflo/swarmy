import * as React from 'react';
import { CopyButton, Label, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { SsoProviderEntry } from './access-shared';
import { certWords, samlMissing, testSignInUrl } from './sso-saml-words';

function UrlLine({ label, hint, value }: { label: string; hint: string; value: string }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label>
        {label} <span className="text-muted-foreground font-normal">· {hint}</span>
      </Label>
      <div className="flex items-center gap-2">
        <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">{value}</code>
        <CopyButton value={value} label="Copy" />
      </div>
    </div>
  );
}

/**
 * The service-provider side of a SAML provider: the URLs the identity provider
 * needs, whether sign-in is live yet, and a link to try it.
 */
export function SsoSamlSetup({ provider: p }: { provider: SsoProviderEntry }): React.JSX.Element | null {
  const s = p.saml;
  if (!s) return null;
  const missing = samlMissing(p.issuer, s);
  const cert = certWords(s.certExpiresAt);
  const certBad = Boolean(cert && !cert.startsWith('Certificate good'));
  const testUrl = testSignInUrl(window.location.origin, p.providerId);
  return (
    <div className="grid gap-3">
      <p className="text-sm font-semibold">Give your identity provider these</p>
      <UrlLine label="Entity ID" hint="Audience / Identifier" value={s.entityId} />
      <UrlLine label="ACS URL" hint="Reply URL, HTTP-POST" value={s.acsUrl} />
      <UrlLine label="Metadata URL" hint="for IdPs that import it" value={s.metadataUrl} />
      <p className={cn('text-sm', missing || certBad ? 'text-tone-warn' : 'text-tone-ok')}>
        {missing ?? (p.enabled ? 'Sign-in through this provider is live.' : 'Ready. Turn the provider on to offer it on the sign-in page.')}
        {!missing && cert ? ` ${cert}` : ''}
      </p>
      {!missing && p.enabled && (
        <UrlLine label="Test sign-in" hint="open in a private window to keep this session" value={testUrl} />
      )}
      <Tech>
        SP-initiated only · assertions signed by the stored certificate · NotBefore/NotOnOrAfter required, 3 min skew · each
        assertion once{s.certSubject ? ` · cert ${s.certSubject}` : ''}
      </Tech>
    </div>
  );
}
