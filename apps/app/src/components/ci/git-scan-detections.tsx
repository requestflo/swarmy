import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { GitChip } from './git-chip';
import { GitHerokuRow } from './git-heroku-row';
import { evidenceAt, kindChip } from './git-scan-model';
import { GitScanTick } from './git-scan-tick';
import type { Detection, HerokuScan } from './git-scan-types';

function Row({ d, dir, on, held, onToggle }: { d: Detection; dir: string; on: boolean; held: boolean; onToggle: () => void }): React.JSX.Element {
  const chip = kindChip(d);
  const [first, ...rest] = d.evidence;
  return (
    <li className={cn('bg-card flex items-start gap-2.5 rounded-xl border px-2.5 py-2 transition-opacity', (!on || held) && 'opacity-55')}>
      <GitScanTick on={on} locked={d.required || held} label={d.required ? `${d.label} (required)` : `Include ${d.label}`} onToggle={onToggle} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <b className="text-[13.5px] font-semibold">{d.via === 'in-process' ? d.label : d.name}</b>
          <GitChip tone={chip.tone}>{chip.word}</GitChip>
          {d.required ? <span className="text-muted-foreground font-mono text-[11px]">required</span> : null}
        </span>
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
            <span className="text-[12.5px] leading-snug">{d.why}</span>
          </span>
        </Depth>
        <Tech>→ {d.maps}</Tech>
      </span>
    </li>
  );
}

/**
 * "Detected · tick what you want": each thing the code needs, with the line
 * that says so. A Heroku app leads with "Looks like a Heroku app": while it
 * is ticked the import writes the swarmy.yaml and the rows below wait.
 */
export function GitScanDetections({
  dir,
  detections,
  selected,
  onToggle,
  heroku,
  herokuOn = false,
  onToggleHeroku,
}: {
  dir: string;
  detections: Detection[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  heroku?: HerokuScan;
  herokuOn?: boolean;
  onToggleHeroku?: () => void;
}): React.JSX.Element {
  const on = detections.filter((d) => d.required || selected.includes(d.id)).length;
  return (
    <section aria-label="Detected" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow">Detected · tick what you want</span>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">
          {herokuOn ? 'heroku import' : `${on} of ${detections.length}`}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {heroku && onToggleHeroku ? <GitHerokuRow dir={dir} heroku={heroku} on={herokuOn} onToggle={onToggleHeroku} /> : null}
        {herokuOn ? (
          <li className="text-muted-foreground px-1 text-[12.5px]">The import writes the swarmy.yaml. Untick it to pick these one by one.</li>
        ) : null}
        {detections.map((d) => (
          <Row key={d.id} d={d} dir={dir} on={Boolean(d.required) || selected.includes(d.id)} held={herokuOn} onToggle={() => onToggle(d.id)} />
        ))}
      </ul>
    </section>
  );
}
