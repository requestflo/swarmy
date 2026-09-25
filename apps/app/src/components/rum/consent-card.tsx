import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import { RumSection, Segmented } from './rum-ui';
import type { RumSettings, SettingsCardProps } from './rum-shared';

type Consent = RumSettings['consent'];

const OPTIONS: { value: Consent; label: string }[] = [
  { value: 'hook', label: 'consent hook' },
  { value: 'cmp', label: 'your CMP' },
  { value: 'none', label: 'no consent step' },
];

const LINE: Record<Consent, string> = {
  hook: 'Identified tracking and replay start only after your cookie banner calls window.swarmyConsent(). Visitors who say no are never identified or recorded.',
  cmp: 'Waits for consent from your IAB TCF v2 consent platform — or the consent hook below — before identifying or recording anyone.',
  none: 'Identifies and records every sampled visitor straight away. Fine for staff tools, not for customers in the EU.',
};

const SNIPPET = `// in your cookie banner, after "Accept":
window.swarmyConsent({ replay: true })
// until then: no recorder, nothing stored`;

/** The consent gate for identified mode (privacy mode needs none). */
export function ConsentCard({ settings: s, onChange, disabled }: SettingsCardProps): React.JSX.Element {
  return (
    <RumSection title="Consent" className="scroll-mt-6">
      <div id="consent" className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Consent gate"
          value={s.consent}
          options={OPTIONS}
          onChange={(consent) => onChange({ consent })}
          disabled={disabled}
        />
      </div>
      <p className={s.consent === 'none' ? 'text-tone-warn text-sm' : 'text-muted-foreground text-sm'}>
        {LINE[s.consent]}
      </p>
      {s.consent !== 'none' ? (
        <div className="bg-muted relative rounded-xl">
          <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs">{SNIPPET}</pre>
          <CopyButton value="window.swarmyConsent({ replay: true })" className="absolute top-2 right-2" />
        </div>
      ) : null}
    </RumSection>
  );
}
