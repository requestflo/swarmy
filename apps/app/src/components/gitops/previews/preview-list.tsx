import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, toneFromStatus } from '@/components/calm';
import type { AppPreview, PreviewRules } from '../gitops-types';
import { planStatus } from '../plan-status';
import { ttlLeft } from './previews-model';

/** Every preview of the app, one card-row each; picking one opens it on the right. */
export function PreviewList({
  previews,
  rules,
  selected,
  onSelect,
}: {
  previews: AppPreview[];
  rules: PreviewRules | null | undefined;
  selected: string | null;
  onSelect: (stack: string) => void;
}): React.JSX.Element {
  return (
    <ul aria-label="Previews" className="flex flex-col gap-2">
      {previews.map((p) => {
        const st = planStatus(p.status);
        const on = p.stack === selected;
        return (
          <li key={p.stack}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(p.stack)}
              className={cn(
                'calm-card flex w-full flex-col gap-1 px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                on ? 'ring-foreground/25 ring-1' : 'hover:bg-foreground/[0.02]',
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[13px] font-semibold">{p.branch ?? `PR #${p.pr}`}</span>
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{p.branch ? 'branch · no PR' : 'pull request'}</span>
                <span className={cn('ml-auto shrink-0 text-xs font-semibold', TONE_TEXT[toneFromStatus(st.tone)])}>{st.label}</span>
              </span>
              <span className="text-muted-foreground truncate font-mono text-[11.5px]">{p.url ?? p.stack}</span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
                <span className={p.data ? 'text-tone-mesh' : 'text-muted-foreground'}>
                  {p.data ? `data: a copy of ${p.data.from}${p.data.scrub ? ' · scrubbed' : ''}` : rules?.resources === 'shared' ? 'data: shares production’s' : 'data: its own, empty'}
                </span>
                <span className="text-muted-foreground font-mono text-[11px]">{ttlLeft(p, rules)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
