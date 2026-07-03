import * as React from 'react';
import type { NotificationChannelKindView } from '@swarmy/core';
import { Input, Label } from '@swarmy/ui';
import { KIND_LABEL } from './channel-kind-picker';

interface ChannelDestinationFieldsProps {
  kind: NotificationChannelKindView;
  to: string;
  onToChange: (v: string) => void;
  url: string;
  onUrlChange: (v: string) => void;
  secret: string;
  onSecretChange: (v: string) => void;
}

/** The kind-dependent destination inputs: email address, or a webhook/incoming URL (+ optional HMAC secret). */
export function ChannelDestinationFields({
  kind,
  to,
  onToChange,
  url,
  onUrlChange,
  secret,
  onSecretChange,
}: ChannelDestinationFieldsProps): React.JSX.Element {
  return (
    <>
      {kind === 'email' ? (
        <div className="space-y-2">
          <Label htmlFor="ch-to">Email address</Label>
          <Input
            id="ch-to"
            type="email"
            placeholder="oncall@yourteam.dev"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="ch-url">
            {kind === 'webhook' ? 'Webhook URL' : `${KIND_LABEL[kind]} incoming-webhook URL`}
          </Label>
          <Input
            id="ch-url"
            placeholder="https://…"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
        </div>
      )}
      {kind === 'webhook' ? (
        <div className="space-y-2">
          <Label htmlFor="ch-secret">HMAC secret (optional)</Label>
          <Input
            id="ch-secret"
            type="password"
            placeholder="min 8 characters — signs X-Swarmy-Signature"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}
