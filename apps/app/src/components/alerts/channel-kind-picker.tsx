import * as React from 'react';
import type { NotificationChannelKindView } from '@swarmy/core';
import { NOTIFICATION_CHANNEL_KINDS } from '@swarmy/core';
import { cn } from '@swarmy/ui';

export const KIND_LABEL: Record<NotificationChannelKindView, string> = {
  email: 'Email',
  slack: 'Slack',
  teams: 'Teams',
  discord: 'Discord',
  telegram: 'Telegram',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  webhook: 'Webhook',
};

interface ChannelKindPickerProps {
  value: NotificationChannelKindView;
  onChange: (kind: NotificationChannelKindView) => void;
}

/** Chip picker for the channel kind (email, chat apps, push services, webhook). */
export function ChannelKindPicker({ value, onChange }: ChannelKindPickerProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {NOTIFICATION_CHANNEL_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-semibold transition-colors pointer-coarse:min-h-11',
            value === k
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}
