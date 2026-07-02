import * as React from 'react';
import { Label, Switch } from '@swarmy/ui';
import { Field } from './field';
import type { ProviderFormFields, SetField } from './form-state';

/** SMTP host/port/user/pass + implicit-TLS toggle. */
export function SmtpFields({
  fields,
  set,
  configured,
}: {
  fields: ProviderFormFields;
  set: SetField;
  configured: boolean;
}): React.JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id="np-host"
        label="SMTP host"
        placeholder="smtp.example.com"
        value={fields.smtpHost}
        onChange={(e) => set('smtpHost', e.target.value)}
      />
      <Field
        id="np-port"
        label="Port"
        inputMode="numeric"
        placeholder="587"
        value={fields.smtpPort}
        onChange={(e) => set('smtpPort', e.target.value)}
      />
      <Field
        id="np-user"
        label="Username (optional)"
        placeholder="mailer"
        value={fields.smtpUser}
        onChange={(e) => set('smtpUser', e.target.value)}
      />
      <Field
        id="np-pass"
        label="Password"
        type="password"
        placeholder={configured ? '••••••••  (kept if blank)' : 'password'}
        hint={configured ? 'Stored — leave blank to keep the saved value.' : undefined}
        value={fields.smtpPass}
        onChange={(e) => set('smtpPass', e.target.value)}
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <Switch
          id="np-secure"
          checked={fields.smtpSecure}
          onCheckedChange={(v) => set('smtpSecure', v === true)}
        />
        <Label htmlFor="np-secure" className="cursor-pointer">
          Implicit TLS (port 465). Off = STARTTLS.
        </Label>
      </div>
    </div>
  );
}
