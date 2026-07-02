import * as React from 'react';
import type { NotifyProviderView } from '@swarmy/core';
import { Field } from './field';
import type { ProviderFormFields, SetField } from './form-state';
import { SmtpFields } from './smtp-fields';

/**
 * Per-provider credential inputs. Secret fields are write-only: when creds for
 * this provider are already stored (`configured`), leaving them blank keeps
 * the saved values.
 */
export function ProviderFields({
  provider,
  fields,
  set,
  configured,
}: {
  provider: NotifyProviderView;
  fields: ProviderFormFields;
  set: SetField;
  configured: boolean;
}): React.JSX.Element {
  const keepHint = configured ? 'Stored — leave blank to keep the saved value.' : undefined;
  const secretPlaceholder = (fresh: string): string =>
    configured ? '••••••••  (kept if blank)' : fresh;

  if (provider === 'smtp') {
    return <SmtpFields fields={fields} set={set} configured={configured} />;
  }
  if (provider === 'resend') {
    return (
      <Field
        id="np-resend"
        label="Resend API key"
        type="password"
        placeholder={secretPlaceholder('re_…')}
        hint={keepHint ?? 'From resend.com → API keys.'}
        value={fields.resendKey}
        onChange={(e) => set('resendKey', e.target.value)}
      />
    );
  }
  if (provider === 'postmark') {
    return (
      <Field
        id="np-postmark"
        label="Postmark server token"
        type="password"
        placeholder={secretPlaceholder('server token')}
        hint={keepHint ?? 'From your Postmark server → API Tokens.'}
        value={fields.postmarkToken}
        onChange={(e) => set('postmarkToken', e.target.value)}
      />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id="np-mg-domain"
        label="Sending domain"
        placeholder="mg.example.com"
        value={fields.mailgunDomain}
        onChange={(e) => set('mailgunDomain', e.target.value)}
      />
      <Field
        id="np-mg-key"
        label="Mailgun API key"
        type="password"
        placeholder={secretPlaceholder('key-…')}
        hint={keepHint}
        value={fields.mailgunKey}
        onChange={(e) => set('mailgunKey', e.target.value)}
      />
      <div className="sm:col-span-2">
        <Field
          id="np-mg-base"
          label="API base (optional)"
          placeholder="https://api.mailgun.net — EU: https://api.eu.mailgun.net"
          value={fields.mailgunBase}
          onChange={(e) => set('mailgunBase', e.target.value)}
        />
      </div>
    </div>
  );
}
