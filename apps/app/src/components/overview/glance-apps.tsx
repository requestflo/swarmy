import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { TrafficNowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';
import { appFacts } from './glance-words';

/** Apps as one-line rows: dot · name · its word when it isn't calm (else its parts) · visits a minute. */
export function GlanceApps({ apps, traffic }: { apps: AppItem[]; traffic: TrafficNowView | undefined }): React.JSX.Element {
  return (
    <section aria-labelledby="glance-apps-h" className="flex flex-col gap-2">
      <h2 id="glance-apps-h" className="calm-eyebrow">
        Apps
      </h2>
      <ul className="flex flex-col gap-2">
        {apps.map((a) => {
          const f = appFacts(a, traffic);
          return (
            <li key={a.name}>
              <Link
                to="/stacks/$name"
                params={{ name: a.name }}
                className="bg-card border-border hover:border-foreground/20 flex min-h-11 items-center gap-2.5 rounded-xl border px-3 text-[14px] font-semibold"
              >
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[a.words.tone], a.words.tone === 'idle' && 'opacity-60')} />
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="text-muted-foreground ml-auto max-w-[62%] shrink-0 truncate font-mono text-[11.5px] font-normal">
                  {f.word ? <span className={TONE_TEXT[a.words.tone]}>{f.word}</span> : null}
                  {f.word && f.facts ? ' · ' : ''}
                  {f.facts}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
