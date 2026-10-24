import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { GitChip } from './git-chip';
import { evidenceAt } from './git-scan-model';
import { GitScanTick } from './git-scan-tick';
import type { HerokuScan } from './git-scan-types';

/**
 * "Looks like a Heroku app" — the found list's first row when a Procfile
 * sits beside a Heroku app.json. Ticked (the start), the swarmy.yaml is the
 * importer's; unticked, the detections below write it as usual.
 */
export function GitHerokuRow({
  dir,
  heroku,
  on,
  onToggle,
}: {
  dir: string;
  heroku: HerokuScan;
  on: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const [first, ...rest] = heroku.evidence;
  return (
    <li className={cn('bg-card flex items-start gap-2.5 rounded-xl border px-2.5 py-2 transition-opacity', !on && 'opacity-55')}>
      <GitScanTick on={on} label="Use the Heroku import" onToggle={onToggle} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <b className="text-[13.5px] font-semibold">{heroku.label}</b>
          <GitChip tone="mesh">heroku</GitChip>
        </span>
        <span className="text-[12.5px] leading-snug">{heroku.why}</span>
        {first ? (
          <span className="text-muted-foreground truncate font-mono text-[11.5px]" title={first.text}>
            {evidenceAt(dir, first)} {first.text}
          </span>
        ) : null}
        <Depth at="controls">
          <span className="flex flex-col gap-0.5">
            {rest.map((e) => (
              <span key={`${e.file}:${e.line}`} className="text-muted-foreground truncate font-mono text-[11.5px]" title={e.text}>
                {evidenceAt(dir, e)} {e.text}
              </span>
            ))}
          </span>
        </Depth>
        <Tech>→ swarmy.yaml from app.json + Procfile</Tech>
      </span>
    </li>
  );
}
