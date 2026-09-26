import * as React from 'react';
import type { DeployStage } from '@swarmy/core/protocol';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, type Tone } from '@/components/calm';
import type { DeployEvent } from './deploy-events';

/** The short stage tag in the log, and its tone. */
export const STAGE_TAG: Record<DeployStage, { tag: string; tone: Tone }> = {
  pull: { tag: 'pull', tone: 'info' },
  data: { tag: 'data', tone: 'mesh' },
  start: { tag: 'svc', tone: 'ok' },
  route: { tag: 'https', tone: 'info' },
  health: { tag: 'check', tone: 'ok' },
};

const hms = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * The deploy's own events as the board's log: mono time · stage tag · the
 * plain line the agent or controller sent. The image pull's progress shows
 * only its latest line until it's done, so the log reads as steps, not a ticker.
 */
export function DeployEventLog({ events }: { events: DeployEvent[] }): React.JSX.Element {
  const box = React.useRef<HTMLOListElement>(null);
  const prog = (e: DeployEvent): boolean => e.stage === 'pull' && e.status === 'progress';
  const lastProg = events.findLastIndex(prog);
  const pulled = events.some((e) => e.stage === 'pull' && e.status === 'done');
  const shown = events.filter((e, i) => !prog(e) || (i === lastProg && !pulled));
  React.useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length]);
  return (
    <ol ref={box} tabIndex={0} aria-label="Deploy log" className="calm-code dark max-h-72 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">
      {shown.map((e) => {
        const t = STAGE_TAG[e.stage];
        return (
          <li key={e.seq} className="grid grid-cols-[auto_3.25rem_minmax(0,1fr)] gap-x-3">
            <time dateTime={new Date(e.at).toISOString()} className="opacity-70">
              {hms(e.at)}
            </time>
            <span className={TONE_TEXT[e.status === 'failed' ? 'bad' : t.tone]}>{t.tag}</span>
            <span className={cn('break-words', e.status === 'failed' && TONE_TEXT.bad)}>{e.message}</span>
          </li>
        );
      })}
    </ol>
  );
}
