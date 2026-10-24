import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { GitChip } from './git-chip';
import { kindChip } from './git-scan-model';
import type { Detection, Evidence } from './git-scan-types';

/** `services/orders/src/queue.ts:3` → `src/queue.ts:3` (the eyebrow already names the folder). */
function where(dir: string, e: Evidence): string {
  return `${dir && e.file.startsWith(`${dir}/`) ? e.file.slice(dir.length + 1) : e.file}:${e.line}`;
}

function Row({ d, dir, on, onToggle }: { d: Detection; dir: string; on: boolean; onToggle: () => void }): React.JSX.Element {
  const chip = kindChip(d);
  const [first, ...rest] = d.evidence;
  return (
    <li className={cn('bg-card flex items-start gap-2.5 rounded-xl border px-2.5 py-2 transition-opacity', !on && 'opacity-55')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-disabled={d.required || undefined}
        aria-label={d.required ? `${d.label} (required)` : `Include ${d.label}`}
        onClick={d.required ? undefined : onToggle}
        className={cn(
          'mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7',
          d.required ? 'border-muted bg-muted text-muted-foreground cursor-default' : on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {on ? <CheckIcon aria-hidden className="size-3" strokeWidth={3.2} /> : null}
      </button>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <b className="text-[13.5px] font-semibold">{d.via === 'in-process' ? d.label : d.name}</b>
          <GitChip tone={chip.tone}>{chip.word}</GitChip>
          {d.required ? <span className="text-muted-foreground font-mono text-[11px]">required</span> : null}
        </span>
        {first ? (
          <span className="text-muted-foreground truncate font-mono text-[11.5px]" title={first.text}>
            {where(dir, first)} {first.text}
          </span>
        ) : null}
        <Depth at="controls">
          <span className="flex flex-col gap-0.5">
            {rest.map((e) => (
              <span key={`${e.file}:${e.line}`} className="text-muted-foreground truncate font-mono text-[11.5px]" title={e.text}>
                {where(dir, e)} {e.text}
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

/** "Detected · tick what you want": each thing the code needs, with the line that says so. */
export function GitScanDetections({
  dir,
  detections,
  selected,
  onToggle,
}: {
  dir: string;
  detections: Detection[];
  selected: readonly string[];
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const on = detections.filter((d) => d.required || selected.includes(d.id)).length;
  return (
    <section aria-label="Detected" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow">Detected · tick what you want</span>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">
          {on} of {detections.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {detections.map((d) => (
          <Row key={d.id} d={d} dir={dir} on={Boolean(d.required) || selected.includes(d.id)} onToggle={() => onToggle(d.id)} />
        ))}
      </ul>
    </section>
  );
}
