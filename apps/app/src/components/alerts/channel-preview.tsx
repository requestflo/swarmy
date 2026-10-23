import * as React from 'react';
import {
  ALERT_SIGNATURE_HEADER,
  renderNotificationSubject,
  renderNotificationText,
  renderWebhookBody,
  testNotification,
  type AlertNotification,
  type NotificationChannelView,
} from '@swarmy/core';
import { Tech } from '@/components/calm';
import { DiscordPreview, PushPreview, TelegramPreview, TextPreview } from './channel-preview-apps';
import { KIND_LABEL } from './channel-kind-picker';

/**
 * TEST MESSAGE · as it lands in Discord: the Send test notification drawn in
 * the app's own look, from the same renderers the controller sends with.
 * `at` is when the test went out (the controller stamps its own clock, so the
 * seconds can differ).
 */
export function ChannelPreview({ channel, at }: { channel: NotificationChannelView; at: string }): React.JSX.Element {
  const n = testNotification(at);
  return (
    <section aria-label={`Test message as it lands in ${KIND_LABEL[channel.kind]}`} className="border-border flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <p className="text-muted-foreground flex flex-wrap justify-between gap-x-3 font-mono text-[11px]">
        <span className="tracking-[0.08em] uppercase">Test message</span>
        <span>as it lands in {KIND_LABEL[channel.kind]}</span>
      </p>
      <Body channel={channel} n={n} />
      <Tech>{payloadNote(channel)}</Tech>
    </section>
  );
}

function Body({ channel, n }: { channel: NotificationChannelView; n: AlertNotification }): React.JSX.Element {
  switch (channel.kind) {
    case 'slack':
    case 'teams':
      return <TextPreview text={renderNotificationText(n)} at={n.at} />;
    case 'discord':
      return <DiscordPreview n={n} />;
    case 'telegram':
      return <TelegramPreview n={n} />;
    case 'ntfy':
    case 'gotify':
      return <PushPreview n={n} kind={channel.kind} where={channel.target} />;
    case 'email':
      return (
        <div className="flex flex-col gap-1 text-[13px]">
          <p className="text-muted-foreground font-mono text-[11px]">to {channel.target}</p>
          <b className="font-semibold">{renderNotificationSubject(n)}</b>
          <p className="leading-snug break-words">{renderNotificationText(n)}</p>
        </div>
      );
    case 'webhook':
      return (
        <pre className="calm-code overflow-x-auto rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed">
          {`POST ${channel.target}/…\nContent-Type: application/json\n`}
          {channel.hasSecret ? `${ALERT_SIGNATURE_HEADER}: sha256=<HMAC of the body>\n` : ''}
          {`\n${JSON.stringify(JSON.parse(renderWebhookBody(n)), null, 2)}`}
        </pre>
      );
  }
}

/** What actually goes over the wire, at Controls. */
function payloadNote(c: NotificationChannelView): string {
  switch (c.kind) {
    case 'slack':
    case 'teams':
      return 'incoming webhook · { text } · the webhook’s own name and icon';
    case 'discord':
      return 'webhook · one embed, coloured by severity · mentions off';
    case 'telegram':
      return `Bot API sendMessage · ${c.target} · MarkdownV2 · link previews off`;
    case 'ntfy':
      return 'JSON publish · priority and tags follow severity';
    case 'gotify':
      return 'POST /message · priority follows severity';
    case 'email':
      return 'through your email provider · plain text';
    case 'webhook':
      return `POST JSON${c.hasSecret ? ` · signed ${ALERT_SIGNATURE_HEADER}` : ' · unsigned'}`;
  }
}
