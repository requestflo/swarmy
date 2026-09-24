import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { RumSection } from './rum-ui';
import type { RumSettings, SettingsCardProps } from './rum-shared';

interface AnalyticsModeCardProps extends SettingsCardProps {
  stack: string;
}

const MODES: { value: RumSettings['mode']; title: string; line: string }[] = [
  { value: 'analytics', title: 'Privacy mode', line: 'cookieless · aggregate · no personal data · default' },
  { value: 'identified', title: 'Identified mode', line: 'ties visits to signed-in users · sessions & replay · needs consent' },
];

/** Privacy (cookieless aggregate) vs identified (people, sessions, replay). */
export function AnalyticsModeCard({ stack, settings: s, onChange, disabled }: AnalyticsModeCardProps): React.JSX.Element {
  return (
    <RumSection
      title="Web analytics mode"
      action={
        <Link to="/stacks/$name/analytics" params={{ name: stack }} className="font-mono text-xs">
          open analytics →
        </Link>
      }
    >
      <div role="radiogroup" aria-label="Analytics mode" className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={s.mode === m.value}
            disabled={disabled}
            onClick={() => onChange({ mode: m.value })}
            className={cn(
              'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
              s.mode === m.value ? 'border-primary/60 bg-accent' : 'border-border hover:bg-accent/50',
            )}
          >
            <b className="text-sm">{m.title}</b>
            <span className="text-muted-foreground text-xs">{m.line}</span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">Session replay needs identified mode.</p>
    </RumSection>
  );
}
