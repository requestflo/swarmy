import * as React from 'react';
import type { ChannelConfigInput, NotificationChannelKindView } from '@swarmy/core';
import { Input, Label } from '@swarmy/ui';
import { KIND_LABEL } from './channel-kind-picker';

/** Every destination input any channel kind uses (unused ones stay blank). */
export interface ChannelFields {
  to: string;
  url: string;
  secret: string;
  botToken: string;
  chatId: string;
  threadId: string;
  server: string;
  topic: string;
  token: string;
}

export const EMPTY_CHANNEL_FIELDS: ChannelFields = {
  to: '',
  url: '',
  secret: '',
  botToken: '',
  chatId: '',
  threadId: '',
  server: '',
  topic: '',
  token: '',
};

/** Form fields → a `ChannelConfigInput`, or null while required fields are blank. */
export function channelConfigFrom(
  kind: NotificationChannelKindView,
  f: ChannelFields,
): ChannelConfigInput | null {
  const t = (v: string): string => v.trim();
  switch (kind) {
    case 'email':
      return t(f.to) ? { kind, to: t(f.to) } : null;
    case 'slack':
    case 'teams':
    case 'discord':
      return t(f.url) ? { kind, url: t(f.url) } : null;
    case 'webhook':
      return t(f.url) ? { kind, url: t(f.url), ...(t(f.secret) ? { secret: t(f.secret) } : {}) } : null;
    case 'telegram': {
      if (!t(f.botToken) || !t(f.chatId)) return null;
      const thread = Number.parseInt(t(f.threadId), 10);
      return {
        kind,
        botToken: t(f.botToken),
        chatId: t(f.chatId),
        ...(Number.isInteger(thread) && thread > 0 ? { threadId: thread } : {}),
      };
    }
    case 'ntfy':
      return t(f.topic)
        ? {
            kind,
            server: t(f.server) || 'https://ntfy.sh',
            topic: t(f.topic),
            ...(t(f.token) ? { token: t(f.token) } : {}),
          }
        : null;
    case 'gotify':
      return t(f.server) && t(f.token) ? { kind, server: t(f.server), token: t(f.token) } : null;
  }
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  hint?: string;
}

function Field({ id, label, value, onChange, placeholder, secret, hint }: FieldProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

interface ChannelDestinationFieldsProps {
  kind: NotificationChannelKindView;
  fields: ChannelFields;
  onChange: (next: ChannelFields) => void;
}

/** The kind-dependent destination inputs for every channel kind. */
export function ChannelDestinationFields({
  kind,
  fields,
  onChange,
}: ChannelDestinationFieldsProps): React.JSX.Element {
  const set =
    (key: keyof ChannelFields) =>
    (v: string): void =>
      onChange({ ...fields, [key]: v });

  switch (kind) {
    case 'email':
      return (
        <Field id="ch-to" label="Email address" value={fields.to} onChange={set('to')} placeholder="oncall@yourteam.dev" />
      );
    case 'telegram':
      return (
        <div className="grid gap-4 lg:grid-cols-3">
          <Field
            id="ch-bot"
            label="Bot token"
            secret
            value={fields.botToken}
            onChange={set('botToken')}
            placeholder="123456:ABC-DEF…"
            hint="From @BotFather. Add the bot to the chat first."
          />
          <Field
            id="ch-chat"
            label="Chat id"
            value={fields.chatId}
            onChange={set('chatId')}
            placeholder="-1001234567890 or @channel"
          />
          <Field
            id="ch-thread"
            label="Topic id (optional)"
            value={fields.threadId}
            onChange={set('threadId')}
            placeholder="forum topics only"
          />
        </div>
      );
    case 'ntfy':
      return (
        <div className="grid gap-4 lg:grid-cols-3">
          <Field
            id="ch-server"
            label="Server"
            value={fields.server}
            onChange={set('server')}
            placeholder="https://ntfy.sh"
            hint="Leave blank for ntfy.sh, or use your own server."
          />
          <Field id="ch-topic" label="Topic" value={fields.topic} onChange={set('topic')} placeholder="swarmy-alerts" />
          <Field
            id="ch-token"
            label="Access token (optional)"
            secret
            value={fields.token}
            onChange={set('token')}
            placeholder="tk_…"
          />
        </div>
      );
    case 'gotify':
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <Field
            id="ch-server"
            label="Server"
            value={fields.server}
            onChange={set('server')}
            placeholder="https://gotify.example.com"
          />
          <Field id="ch-token" label="App token" secret value={fields.token} onChange={set('token')} />
        </div>
      );
    default:
      return (
        <>
          <Field
            id="ch-url"
            label={kind === 'webhook' ? 'Webhook URL' : `${KIND_LABEL[kind]} webhook URL`}
            value={fields.url}
            onChange={set('url')}
            placeholder={
              kind === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://…'
            }
          />
          {kind === 'webhook' ? (
            <Field
              id="ch-secret"
              label="HMAC secret (optional)"
              secret
              value={fields.secret}
              onChange={set('secret')}
              placeholder="min 8 characters — signs X-Swarmy-Signature"
            />
          ) : null}
        </>
      );
  }
}
