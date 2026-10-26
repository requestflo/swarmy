import * as React from 'react';
import { Tech } from '@/components/calm';
import { foundNeeds, needsHead } from './git-found-model';
import { scannedLabel } from './git-scan-model';
import type { AppScan } from './git-scan-types';

/**
 * "What we found · live" (board 23): what the picked folder's code needs —
 * Postgres, Redis, S3, schedules — each with why we think so and what the
 * drafted swarmy.yaml adds for it. Link & scan lets you tick which go in.
 */
export function GitFoundNeeds({ scan }: { scan: AppScan }): React.JSX.Element {
  const needs = foundNeeds(scan.detections);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">{needsHead(needs.length)}</span>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">{scannedLabel(scan.files, scan.ms)}</span>
      </div>
      {needs.length ? (
        <ul aria-label="What its code needs" className="flex flex-col gap-1.5">
          {needs.map((n) => (
            <li key={n.id} className="bg-card flex min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-2">
              <span className="text-[13px] font-semibold">{n.kind}</span>
              <span className="text-muted-foreground text-[12.5px] leading-snug [overflow-wrap:anywhere]">{n.why}</span>
              <span className="text-tone-ok text-[12.5px] leading-snug">{n.adds}</span>
              <Tech>→ {n.maps}</Tech>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-[12.5px]">No database, cache, bucket or schedule in its code — you can add one later in swarmy.yaml.</p>
      )}
      {needs.length ? <span className="text-muted-foreground text-xs">Link & scan to tick which ones go into the swarmy.yaml we draft. Connection strings never land in git.</span> : null}
    </div>
  );
}
