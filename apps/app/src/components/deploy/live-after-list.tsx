import * as React from 'react';
import { Section } from '@/components/calm';

/**
 * "After it's live" (board 53): the template's first-login steps, numbered,
 * with `<url>` as the real address. Nothing secret lives here.
 */
export function LiveAfterList({ steps, url }: { steps: string[]; url: string | null }): React.JSX.Element | null {
  if (steps.length === 0) return null;
  const say = (line: string): string => (url ? line.replaceAll('<url>', url).replaceAll('the app URL', url) : line.replaceAll('<url>', 'the app’s address'));
  return (
    <Section title="After it’s live" count={steps.length}>
      <ol className="flex flex-col gap-2">
        {steps.map((line, i) => (
          <li key={line} className="flex gap-3 text-[13.5px] leading-snug">
            <span aria-hidden className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]">
              {i + 1}
            </span>
            <span className="min-w-0 break-words">{say(line)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
