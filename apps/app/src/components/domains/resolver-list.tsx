import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import type { ResolverView } from '@/components/ingress/domain-state';
import { RESOLVER_WORD, resolverAnswer } from './resolver-words';

/** One resolver: dot · name · home city, then what it answered. */
function ResolverItem({ r }: { r: ResolverView }): React.JSX.Element {
  const w = RESOLVER_WORD[r.state];
  return (
    <li className="border-border flex min-w-0 gap-2.5 border-b py-2">
      <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[w.tone])} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-snug">
          <span className="font-semibold">{r.name}</span>
          {r.city ? <span className="text-muted-foreground"> · {r.city}</span> : null}
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11.5px]">
          <span className="min-w-0 break-all">{resolverAnswer(r)}</span>
          {/* The dot says "sees your edges"; only the exceptions are spelled out. */}
          <span className={r.state === 'agrees' ? 'sr-only' : TONE_TEXT[w.tone]}>{w.word}</span>
        </span>
        {r.url ? (
          <Tech>
            {r.format === 'wire' ? 'RFC 8484 wire' : 'JSON'} · {r.url}
            {r.anchor ? ' · anchor' : ''}
          </Tech>
        ) : null}
        {r.error && r.state === 'no_answer' ? <Tech>{r.error}</Tech> : null}
      </span>
    </li>
  );
}

/** The resolver list under the map: two columns on wide screens, one on a phone. */
export function ResolverList({ resolvers, label }: { resolvers: ResolverView[]; label: string }): React.JSX.Element {
  return (
    <ul aria-label={label} className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
      {resolvers.map((r) => (
        <ResolverItem key={r.id} r={r} />
      ))}
    </ul>
  );
}

/** The map legend: what each dot colour means, and the edge marker. */
export function MapLegend({ edges }: { edges: string[] }): React.JSX.Element {
  const items: Array<[string, string]> = [
    [TONE_DOT.ok, 'sees your edges'],
    [TONE_DOT.warn, 'still cached · an old answer'],
    [TONE_DOT.idle, 'no answer'],
  ];
  return (
    <ul aria-label="Legend" className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
      {items.map(([dot, word]) => (
        <li key={word} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-2 rounded-full', dot)} />
          {word}
        </li>
      ))}
      {edges.length ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-foreground size-2 rotate-45" />
          your servers · {edges.join(', ')}
        </li>
      ) : null}
    </ul>
  );
}
