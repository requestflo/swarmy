import * as React from 'react';
import { cn } from '@swarmy/ui';
import { useDepthDefault, type DepthName } from '@/components/calm';

const OPTIONS: { d: DepthName; glyph: string; label: string; say: string }[] = [
  { d: 'summary', glyph: 'Aa', label: 'Summary', say: 'Plain words: what is happening and the one thing to do next. Dig in when you want.' },
  { d: 'controls', glyph: '⚙', label: 'Controls', say: 'The settings and numbers up front: copies, memory, addresses, versions.' },
  { d: 'code', glyph: '</>', label: 'Code', say: 'Pages open as swarmy.yaml, compose, CLI and REST. For people who live in a terminal.' },
];

/**
 * First run: "How much do you want to see?" Sets the person's default depth
 * (the sidenav "Show me" dial) and disappears once they have chosen.
 */
export function DepthWelcomeCard({ className }: { className?: string }): React.JSX.Element | null {
  const { value, chosen, set } = useDepthDefault();
  if (chosen) return null;
  return (
    <section aria-labelledby="depth-welcome-h" className={cn('flex flex-col gap-2', className)}>
      <h2 id="depth-welcome-h" className="calm-eyebrow">
        How much do you want to see?
      </h2>
      <div className="grid gap-2 lg:grid-cols-3">
        {OPTIONS.map((o) => (
          <button
            key={o.d}
            type="button"
            aria-pressed={value === o.d}
            onClick={() => set(o.d)}
            className={cn(
              'calm-card flex items-start gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              value === o.d ? 'border-primary/60' : 'hover:border-foreground/25',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[11px]',
                value === o.d ? 'bg-primary/15 text-tone-bad' : 'bg-foreground/10 text-muted-foreground',
              )}
            >
              {o.glyph}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[14px] font-semibold">{o.label}</span>
              <span className="text-muted-foreground text-[12.5px] leading-snug">{o.say}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        It only sets where pages open. Every page and section can still switch, and it is the same app either way.
      </p>
    </section>
  );
}
