import * as React from 'react';
import { Switch } from '@swarmy/ui';
import { Chip, RumSection, Segmented } from './rum-ui';
import type { RumSettingsView, SettingsCardProps } from './rum-shared';

interface RecordingCardProps extends SettingsCardProps {
  stores: RumSettingsView['stores'];
}

const CSP = [
  { value: 'rewrite' as const, label: 'rewrite CSP' },
  { value: 'skip' as const, label: 'skip CSP pages' },
];

/** The master switch, and how the tag gets onto the page (the edge, never the app). */
export function RecordingCard({ settings: s, onChange, disabled, stores }: RecordingCardProps): React.JSX.Element {
  return (
    <RumSection
      title="Analytics & session replay"
      badge={<Chip tone={s.enabled ? 'online' : 'neutral'}>{s.enabled ? 'on' : 'off'}</Chip>}
      action={
        <Switch
          checked={s.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label="Turn on analytics and replay for this app"
        />
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Injected at the edge by Caddy — your app is never modified or redeployed. Changes apply on the
        next page view. Replay also needs identified mode and a sample rate above 0%.
      </p>
      {!stores.analytics ? (
        <p className="text-status-warning text-sm">
          Observability is off, so there's nowhere to count visits. Turn observability on for analytics.
        </p>
      ) : null}
      {!stores.replay ? (
        <p className="text-status-warning text-sm">
          Object storage isn't set up, so replays can't be kept. Set up object storage (Data → Object storage) for replay.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-24 text-sm font-semibold">CSP</span>
        <Segmented
          label="Content-Security-Policy handling"
          value={s.csp}
          options={CSP}
          onChange={(csp) => onChange({ csp })}
          disabled={disabled}
        />
        <span className="text-muted-foreground text-xs">
          {s.csp === 'rewrite'
            ? 'The edge adjusts your CSP header so the tag may run.'
            : 'Pages that send a CSP header are left alone — nothing is injected on them.'}
        </span>
      </div>
    </RumSection>
  );
}
