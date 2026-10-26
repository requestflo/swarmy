import * as React from 'react';
import { DatabaseIcon, FolderIcon } from 'lucide-react';
import type { AppRestorePlan, AppRestoreScopeView } from '@swarmy/core';
import { Tech } from '@/components/calm';
import { LEFT_OUT_WORDS, partWords, refusalWords, shortVolume } from './app-restore-words';

const METHOD_TECH = { volume: 'restic restore', pitr: 'pitr', logical: 'in-place load' } as const;

interface AppRestorePartsProps {
  stack: string;
  plan: AppRestorePlan;
  scope: AppRestoreScopeView;
}

/**
 * Each part of the app and where it lands, the parts that can't go back that
 * far (crimson), and what the restore leaves alone.
 */
export function AppRestoreParts({ stack, plan, scope }: AppRestorePartsProps): React.JSX.Element {
  const name = (kind: 'volume' | 'database', n: string): string => (kind === 'volume' ? shortVolume(n, stack) : n);
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-border flex flex-col divide-y" aria-label="Parts">
        {plan.parts.map((p) => (
          <li key={`${p.kind}-${p.name}`} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
            <span className="flex items-baseline gap-2 text-[13.5px]">
              {p.kind === 'volume' ? (
                <FolderIcon aria-hidden className="text-muted-foreground size-4 shrink-0 self-center" />
              ) : (
                <DatabaseIcon aria-hidden className="text-muted-foreground size-4 shrink-0 self-center" />
              )}
              <span className="min-w-0">
                <span className="font-semibold">{name(p.kind, p.name)}</span>
                <span className="text-muted-foreground"> {p.kind === 'volume' ? 'files' : 'database'} &middot; {partWords(p, plan.at)}</span>
              </span>
            </span>
            <Tech>
              {p.name} · {METHOD_TECH[p.method]}
              {p.engine ? ` · ${p.engine}` : ''}
              {p.pointId ? ` · ${p.pointId.slice(0, 12)}` : ` · to ${new Date(p.at).toISOString()}`} · saved first, then written over
            </Tech>
          </li>
        ))}
        {plan.refused.map((r) => (
          <li key={`${r.kind}-${r.name}`} className="flex items-center gap-2 py-2 text-[13.5px]">
            <span aria-hidden className="bg-status-offline size-2 shrink-0 rounded-full" />
            <span className="font-semibold">{name(r.kind, r.name)}</span>
            <span className="text-tone-bad">{refusalWords(r)}</span>
          </li>
        ))}
      </ul>
      {scope.leftOut.length ? (
        <p className="text-muted-foreground text-[12.5px] leading-snug">
          Left as they are:{' '}
          {scope.leftOut.map((l, i) => (
            <React.Fragment key={l.volume}>
              {i ? '; ' : ''}
              <span className="text-foreground font-mono">{shortVolume(l.volume, stack)}</span> ({LEFT_OUT_WORDS[l.why]})
            </React.Fragment>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}
