import * as React from 'react';
import type { ComposeGap } from '@swarmy/app-config';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT } from '@/components/calm';
import { sentence, sortGaps } from './convert-model';

/**
 * "What didn't translate": each compose setting the file couldn't carry,
 * from which service, and why — with what to do instead. Settings swarmy
 * covers itself (depends_on, restart …) sit last and quieter.
 */
export function ConvertGaps({ gaps }: { gaps: readonly ComposeGap[] }): React.JSX.Element {
  const lost = gaps.filter((g) => !g.handled).length;
  const covered = gaps.length - lost;
  if (!gaps.length) {
    return (
      <Section title="Everything translated">
        <p className="text-muted-foreground text-[13.5px]">Every setting in the compose has a home in swarmy.yaml.</p>
      </Section>
    );
  }
  return (
    <Section
      title="What didn’t translate"
      count={lost ? `${lost} to look at` : 'nothing lost'}
      hint={covered ? `+ ${covered} swarmy does itself` : undefined}
      flush
    >
      <ul className="flex flex-col">
        {sortGaps(gaps).map((g, i) => (
          <li key={`${g.service}:${g.key}:${i}`} className="border-border flex min-h-12 items-start gap-3 border-b py-2.5 last:border-b-0">
            <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', g.handled ? TONE_DOT.idle : TONE_DOT.warn)} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-[12px] break-all">
                <span className="font-semibold">{g.service}</span>
                <span className="text-muted-foreground"> · </span>
                {g.key}
              </span>
              <span className={cn('text-[13.5px] leading-snug', g.handled && 'text-muted-foreground')}>{sentence(g.reason)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** "What changed shape": the databases that became managed, the URLs that became bindings. */
export function ConvertChanges({ changes }: { changes: readonly string[] }): React.JSX.Element | null {
  if (!changes.length) return null;
  return (
    <Section title="What changed shape" count={changes.length}>
      <ul className="flex flex-col gap-1.5">
        {changes.map((c) => (
          <li key={c} className="flex items-start gap-2.5 text-[13px] leading-snug">
            <span aria-hidden className={cn('mt-[6px] size-1.5 shrink-0 rounded-full', TONE_DOT.ok)} />
            <span className="min-w-0 break-words">{c}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
