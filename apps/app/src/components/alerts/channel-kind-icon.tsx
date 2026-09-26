import * as React from 'react';
import { BellIcon, MailIcon, MessageSquareIcon, SendIcon, SlackIcon, UsersIcon, WebhookIcon, type LucideIcon } from 'lucide-react';
import type { NotificationChannelKindView, NotificationChannelView } from '@swarmy/core';
import { KIND_LABEL } from './channel-kind-picker';

const ICON: Record<NotificationChannelKindView, LucideIcon> = {
  email: MailIcon,
  slack: SlackIcon,
  teams: UsersIcon,
  discord: MessageSquareIcon,
  telegram: SendIcon,
  ntfy: BellIcon,
  gotify: BellIcon,
  webhook: WebhookIcon,
};

/** The kind's icon in a quiet square. */
export function ChannelKindIcon({ kind }: { kind: NotificationChannelKindView }): React.JSX.Element {
  const Icon = ICON[kind];
  return (
    <span aria-hidden className="bg-surface-2 dark:bg-accent text-muted-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
      <Icon className="size-4" />
    </span>
  );
}

/** "Email · on•••@northwind.dev" — the redacted target, with an email's name part masked too. */
export function maskedTarget(c: NotificationChannelView): string {
  const t = c.kind === 'email' ? c.target.replace(/^(.{2})[^@]*@/, '$1•••@') : c.target;
  return `${KIND_LABEL[c.kind]} · ${t}${c.kind === 'webhook' && c.hasSecret ? ' · signed' : ''}`;
}
