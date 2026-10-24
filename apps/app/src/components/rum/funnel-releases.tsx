import * as React from 'react';
import { cn } from '@swarmy/ui';
import { agoWords } from '@/components/app-tabs/releases/release-label';
import { compact, pct } from './rum-shared';
import { versionLabel, type FunnelView } from './funnel-model';

interface FunnelReleasesProps {
  view: FunnelView;
}

/**
 * Controls depth: the biggest drop per release, newest first. A visit counts
 * under the release that was live when it began (RUM rows carry no release
 * tag), so a canary's share shows up under the version that went out.
 */
export function FunnelReleases({ view }: FunnelReleasesProps): React.JSX.Element | null {
  const d = view.biggestDrop;
  if (!d || view.releases.length < 2) return null;
  const from = view.steps[d.index - 1]?.name ?? '';
  const to = view.steps[d.index]?.name ?? '';
  return (
    <div className="flex flex-col gap-1">
      <h3 className="mono-label text-muted-foreground">
        {from} → {to} per release
      </h3>
      <ul className="divide-border flex flex-col divide-y">
        {view.releases.map((r) => {
          const conv = r.reached ? r.converted / r.reached : 0;
          const worse = view.since?.releaseId === r.releaseId;
          return (
            <li key={r.releaseId || 'earlier'} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-sm">
              <span className={cn('w-28 font-mono text-xs font-semibold', worse && 'text-tone-warn')}>{versionLabel(r.image)}</span>
              <span className="text-muted-foreground font-mono text-xs">{r.at ? agoWords(r.at) : '—'}</span>
              <span className="ml-auto font-mono text-xs">
                {r.reached ? `${compact(r.reached)} reached ${from} · ${pct(conv)} ${to}` : `no one reached ${from}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
