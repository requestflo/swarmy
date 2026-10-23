import * as React from 'react';
import { DatabaseBackupIcon } from 'lucide-react';
import { EmptyState, cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { NIGHTS, newestCell, nightLabel, nightMonths, type CellState, type GridCell, type GridLane } from './restore-grid-model';
import { RestorePointDetail } from './restore-point-detail';
import type { RestoreGridData } from './use-restore-grid';

const DOT: Record<CellState, string> = {
  ok: 'bg-status-online',
  retried: 'bg-status-online ring-2 ring-status-warning ring-offset-1 ring-offset-card',
  failed: 'bg-status-offline',
  running: 'bg-status-progress motion-safe:animate-pulse',
};
const SAY: Record<CellState, string> = { ok: 'saved', retried: 'retried, saved', failed: 'failed', running: 'saving now' };
const COLS = { gridTemplateColumns: `minmax(8.5rem, 15rem) repeat(${NIGHTS}, minmax(1.75rem, 1fr))` };

function Legend(): React.JSX.Element {
  return (
    <span className="text-muted-foreground flex items-center gap-3 font-mono text-[11px]">
      {(['ok', 'retried', 'failed'] as const).map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-2 rounded-full', DOT[s])} />
          {SAY[s]}
        </span>
      ))}
    </span>
  );
}

function Lane({ lane, sel, onPick }: { lane: GridLane; sel: number | null; onPick: (night: number) => void }): React.JSX.Element {
  return (
    <div role="row" className="border-border grid min-h-11 items-center border-t" style={COLS}>
      <span role="rowheader" className="flex min-w-0 flex-col pr-3">
        <span className="truncate text-[13.5px] font-semibold" title={lane.name}>{lane.name}</span>
        <span className="text-muted-foreground truncate font-mono text-[11px]">{lane.meta}</span>
      </span>
      {lane.cells.map((c: GridCell | null, i) => (
        <span key={i} role="gridcell" className="flex justify-center">
          {c ? (
            <button
              type="button"
              aria-label={`${lane.name}, ${new Date(c.save.atMs).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${SAY[c.state]}`}
              aria-pressed={sel === i}
              onClick={() => onPick(i)}
              className={cn(
                'relative size-3 rounded-full outline-none before:absolute before:-inset-2.5 before:content-[""] focus-visible:ring-2 focus-visible:ring-ring/60',
                DOT[c.state],
                sel === i && 'outline-primary outline-2 outline-offset-2',
              )}
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** Restore points as a grid: each saved thing a lane, 14 nights across; click a dot to restore from it. */
export function RestoreGridCard({ grid }: { grid: RestoreGridData }): React.JSX.Element {
  const [pick, setPick] = React.useState<{ key: string; night: number } | null>(null);
  // On a narrow screen the grid scrolls sideways: start at the newest nights.
  const scroller = React.useRef<HTMLDivElement>(null);
  const laneCount = grid.lanes.length;
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [laneCount]);
  const def = newestCell(grid.lanes);
  const picked = pick ? grid.lanes.findIndex((l) => l.key === pick.key) : -1;
  const at = picked >= 0 && grid.lanes[picked]!.cells[pick!.night] ? { lane: picked, night: pick!.night } : def;
  const lane = at ? grid.lanes[at.lane]! : null;
  const cell = at && lane ? lane.cells[at.night] ?? null : null;
  return (
    <Section title="Restore points" count={`${NIGHTS} nights`} hint="click a dot to restore from it" action={<Legend />}>
      {grid.lanes.length === 0 ? (
        <EmptyState
          className="border-0"
          icon={<DatabaseBackupIcon />}
          title="No restore points in the last two weeks"
          description="Every app volume and database is saved nightly. The first ones land here after tonight's run, or back one up now from its app's Backups tab."
        />
      ) : (
        <div ref={scroller} className="-mx-1 overflow-x-auto px-1">
          <div role="grid" aria-label="Restore points by night" className="min-w-[36rem]">
            <div role="row" className="text-muted-foreground grid pb-1.5 font-mono text-[10.5px]" style={COLS}>
              <span role="columnheader">{nightMonths(grid.starts)} (UTC)</span>
              {grid.starts.map((s, i) => (
                <span key={s} role="columnheader" className="text-center">{nightLabel(s, i === grid.starts.length - 1)}</span>
              ))}
            </div>
            {grid.lanes.map((l, li) => (
              <Lane key={l.key} lane={l} sel={at && at.lane === li ? at.night : null} onPick={(night) => setPick({ key: l.key, night })} />
            ))}
          </div>
        </div>
      )}
      {lane && cell ? <RestorePointDetail lane={lane} cell={cell} /> : null}
      {grid.catalogErrors.length ? <Tech always>Couldn’t list database saves in {grid.catalogErrors.join(' · ')}</Tech> : null}
    </Section>
  );
}
