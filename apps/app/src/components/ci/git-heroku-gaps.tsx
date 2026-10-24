import * as React from 'react';
import { Depth } from '@/components/calm';
import type { HerokuGap } from './git-scan-types';

function GapList({ gaps }: { gaps: HerokuGap[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {gaps.map((g) => (
        <li key={g.key} className="flex flex-col gap-0.5 text-[13px] leading-snug">
          <span className="font-mono text-[12px] font-semibold">{g.key}</span>
          <span className="text-muted-foreground">{g.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the Heroku import couldn't put in swarmy.yaml, each with why and what
 * to do instead. What swarmy covers itself, and what changed shape on the
 * way, wait at Controls.
 */
export function GitHerokuGaps({ untranslated, changes }: { untranslated: HerokuGap[]; changes: string[] }): React.JSX.Element {
  const todo = untranslated.filter((g) => !g.handled);
  const handled = untranslated.filter((g) => g.handled);
  return (
    <section aria-label="What didn't come across" className="flex min-w-0 flex-col gap-2">
      <span className="calm-eyebrow">
        Didn’t come across · {todo.length ? `${todo.length} to do` : 'nothing to do'}
      </span>
      {todo.length ? <GapList gaps={todo} /> : <p className="text-muted-foreground text-[13px]">Everything in app.json and the Procfile has a home in swarmy.yaml.</p>}
      <Depth at="controls">
        <div className="flex flex-col gap-3 pt-1">
          {handled.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="calm-eyebrow">swarmy does these itself</span>
              <GapList gaps={handled} />
            </div>
          ) : null}
          {changes.length ? (
            <div className="flex flex-col gap-1">
              <span className="calm-eyebrow">What changed shape</span>
              <ul className="text-muted-foreground flex flex-col gap-0.5 text-[12.5px] leading-snug">
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Depth>
    </section>
  );
}
