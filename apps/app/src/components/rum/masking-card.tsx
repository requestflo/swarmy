import * as React from 'react';
import { Switch } from '@swarmy/ui';
import { Chip, RumSection } from './rum-ui';
import { SelectorsEditor } from './selectors-editor';
import type { SettingsCardProps } from './rum-shared';

/** What the recorder may see. Inputs are always masked — that one isn't a setting. */
export function MaskingCard({ settings: s, onChange, disabled }: SettingsCardProps): React.JSX.Element {
  return (
    <RumSection title="Masking" badge={<Chip tone="online">inputs masked by default</Chip>}>
      <Row label="All form inputs" hint="typed text becomes ••••, always">
        <Chip>locked on</Chip>
      </Row>
      <Row label="All page text" hint="for pages that show personal data">
        <Switch
          checked={s.maskAllText}
          disabled={disabled}
          onCheckedChange={(maskAllText) => onChange({ maskAllText })}
          aria-label="Mask all page text"
        />
      </Row>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">
          Never record <span className="text-muted-foreground font-normal">· blocked, drawn as a grey box</span>
        </span>
        <SelectorsEditor
          value={s.blockSelectors}
          disabled={disabled}
          onChange={(blockSelectors) => onChange({ blockSelectors })}
        />
      </div>
    </RumSection>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex items-center gap-3 border-b pb-2 text-sm">
      <span className="w-32 font-semibold">{label}</span>
      <span className="text-muted-foreground flex-1 text-xs">{hint}</span>
      {children}
    </div>
  );
}
