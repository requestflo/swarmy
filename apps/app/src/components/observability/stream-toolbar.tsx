import * as React from 'react';
import { PauseIcon, PlayIcon, SearchIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { LEVEL_DOT, LOG_RANGE_PRESETS, type LogRangePreset } from './logs-shared';
import type { LevelCounts, LevelFilter } from './stream-model';

const CHIPS: Array<{ level: LevelFilter; label: string }> = [
  { level: 'all', label: 'All' },
  { level: 'error', label: 'Error' },
  { level: 'warn', label: 'Warn' },
  { level: 'info', label: 'Info' },
  { level: 'debug', label: 'Debug' },
];

const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11';

export interface StreamToolbarProps {
  level: LevelFilter;
  counts: LevelCounts;
  onLevel: (l: LevelFilter) => void;
  parts: string[];
  part: string;
  onPart: (p: string) => void;
  search: string;
  onSearch: (s: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  range: LogRangePreset;
  onRange: (r: LogRangePreset) => void;
  paused: boolean;
  onTogglePause: () => void;
  group: string | null;
  onClearGroup: () => void;
}

/** Search (/), level chips with counts, part and window, and Live | Pause (space). */
export function StreamToolbar(p: StreamToolbarProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="border-border bg-background focus-within:ring-ring/60 flex h-9 min-w-0 flex-1 basis-56 items-center gap-2 rounded-[10px] border px-3 focus-within:ring-2 pointer-coarse:min-h-11">
          <SearchIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="sr-only">Search the lines</span>
          <input ref={p.searchRef} value={p.search} onChange={(e) => p.onSearch(e.target.value)} placeholder="Search the lines" className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
          <kbd className="text-muted-foreground rounded border px-1.5 font-mono text-[11px]">/</kbd>
        </label>
        <select aria-label="Part" value={p.part} onChange={(e) => p.onPart(e.target.value)} className="border-border bg-background h-9 rounded-[10px] border px-2.5 text-[13px] pointer-coarse:min-h-11">
          <option value="">Every part</option>
          {p.parts.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
        <div role="group" aria-label="Time range" className="border-border inline-flex rounded-[10px] border p-0.5">
          {LOG_RANGE_PRESETS.map((r) => (
            <button key={r.value} type="button" aria-pressed={p.range === r.value} onClick={() => p.onRange(r.value)}
              className={cn('h-7 rounded-[8px] px-2.5 font-mono text-[12px] font-semibold pointer-coarse:min-h-10', p.range === r.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {r.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={p.onTogglePause} aria-pressed={p.paused} className="h-9 gap-1.5 pointer-coarse:min-h-11">
          {p.paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
          {p.paused ? 'Resume' : 'Pause'}
          <Depth at="controls"><kbd className="text-muted-foreground rounded border px-1 font-mono text-[10.5px]">space</kbd></Depth>
        </Button>
        <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', p.paused ? 'text-muted-foreground' : 'text-tone-ok')} aria-live="polite">
          <span className={cn('size-2 rounded-full', p.paused ? 'bg-status-idle' : 'bg-status-online motion-safe:animate-pulse')} />
          {p.paused ? 'Paused' : 'Live'}
        </span>
      </div>
      <div role="group" aria-label="Level" className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map((c) => (
          <button key={c.level} type="button" aria-pressed={p.level === c.level} onClick={() => p.onLevel(c.level)}
            className={cn(chip, p.level === c.level ? 'border-foreground/30 bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
            {c.level !== 'all' ? <span className={cn('size-1.5 rounded-full', LEVEL_DOT[c.level])} aria-hidden /> : null}
            {c.label}
            <span className="font-mono font-normal">{p.counts[c.level].toLocaleString('en-GB')}</span>
          </button>
        ))}
        {p.group ? (
          <button type="button" onClick={p.onClearGroup} className={cn(chip, 'border-border text-foreground max-w-full')}>
            <span className="truncate">Only this error</span>
            <XIcon className="size-3.5 shrink-0" aria-label="Show every line" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
