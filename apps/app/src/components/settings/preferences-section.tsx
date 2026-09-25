import * as React from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@swarmy/ui';
import { DEPTH_LABEL, DepthSegments, Section, Tech, useDepthDefault, type DepthName } from '@/components/calm';

const EXPLAIN: Record<DepthName, string> = {
  summary: 'A plain sentence about each screen and the one thing worth doing. Nothing technical.',
  controls: 'Adds the knobs and forms, with the technical detail (ids, labels, limits) inline.',
  code: 'Adds the exact swarmy.yaml, CLI and REST for what is on screen, ready to copy.',
};

/** Preferences: the "Show me" default depth (explained) and the theme. */
export function PreferencesSection(): React.JSX.Element {
  const { value, set } = useDepthDefault();
  const { theme, setTheme } = useTheme();
  return (
    <Section id="preferences" title="Preferences" hint="yours only">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[14px] font-semibold">Show me</span>
          <DepthSegments value={value} onChange={set} label="How much detail to show by default" />
        </div>
        <p className="text-muted-foreground text-[13.5px]">
          <b className="text-foreground">{DEPTH_LABEL[value]}</b>: {EXPLAIN[value]} Every page still has its own switch at the top, and goes back to this when you leave it.
        </p>
        <Tech>stored in this browser as swarmy-depth:&lt;your user id&gt;</Tech>
      </div>
      <div className="border-border flex flex-wrap items-center gap-3 border-t pt-3">
        <span className="text-[14px] font-semibold">Appearance</span>
        <div role="group" aria-label="Appearance" className="border-border bg-background inline-flex gap-0.5 rounded-[10px] border p-0.5">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
              className={cn(
                'h-7 rounded-[8px] px-2.5 text-xs font-semibold capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                theme === t ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
