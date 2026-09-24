import * as React from 'react';
import { PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { clock } from './rum-shared';
import { TICK_COLOR } from './replay-scrubber';
import { Segmented } from './rum-ui';
import type { TickKind } from './replay-timeline';

interface ReplayControlsProps {
  playing: boolean;
  ready: boolean;
  time: number;
  total: number;
  speed: number;
  nowLabel?: string;
  onToggle: () => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [1, 2, 4, 8].map((v) => ({ value: v, label: `${v}×` }));
const LEGEND: [TickKind, string][] = [
  ['page', 'page'],
  ['click', 'click'],
  ['net', 'network'],
  ['error', 'error'],
];

/** Play / pause, the clock, speed, and the tick legend (identity never colour alone). */
export function ReplayControls({
  playing,
  ready,
  time,
  total,
  speed,
  nowLabel,
  onToggle,
  onSpeed,
}: ReplayControlsProps): React.JSX.Element {
  const ended = !playing && time >= total - 50 && total > 0;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)]"
        onClick={onToggle}
        disabled={!ready}
      >
        {playing ? <PauseIcon className="size-4" /> : ended ? <RotateCcwIcon className="size-4" /> : <PlayIcon className="size-4" />}
        {playing ? 'Pause' : ended ? 'Replay' : 'Play'}
      </Button>
      <span className="font-mono text-sm">
        {clock(time)} / {clock(total)}
      </span>
      {nowLabel ? <span className="text-muted-foreground hidden truncate text-sm sm:inline">· {nowLabel}</span> : null}
      <Segmented label="Playback speed" value={speed} options={SPEEDS} onChange={onSpeed} />
      <span className="text-muted-foreground ml-auto flex flex-wrap gap-3 font-mono text-[11px]">
        {LEGEND.map(([k, l]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <i className={cn('inline-block size-2 rounded-full', TICK_COLOR[k])} /> {l}
          </span>
        ))}
      </span>
    </div>
  );
}
