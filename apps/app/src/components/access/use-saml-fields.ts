import * as React from 'react';
import type { SsoProviderEntry } from './access-shared';
import { samlPatch, type SamlFields } from './sso-saml-words';

function fromProvider(p: SsoProviderEntry): SamlFields {
  const m = p.metadata ?? {};
  return {
    issuer: p.issuer ?? '',
    entryPoint: typeof m.entryPoint === 'string' ? m.entryPoint : '',
    cert: typeof m.cert === 'string' ? m.cert : '',
    metadataXml: '',
  };
}

/**
 * The IdP side of a SAML provider as the admin edits it. `reset` takes the
 * saved provider back, so fields read out of pasted metadata show up and the
 * paste box empties.
 */
export function useSamlFields(p: SsoProviderEntry): {
  value: SamlFields;
  set: (patch: Partial<SamlFields>) => void;
  reset: (saved: SsoProviderEntry) => void;
  toPatch: () => ReturnType<typeof samlPatch>;
} {
  const [value, setValue] = React.useState<SamlFields>(() => fromProvider(p));
  return {
    value,
    set: (patch) => setValue((v) => ({ ...v, ...patch })),
    reset: (saved) => setValue(fromProvider(saved)),
    toPatch: () => samlPatch(value),
  };
}
