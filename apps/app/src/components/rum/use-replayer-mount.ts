import * as React from 'react';
import type { Replayer } from '@rrweb/replay';

type RrEvents = ConstructorParameters<typeof Replayer>[0];

export interface MountedReplayer {
  ref: React.RefObject<Replayer | null>;
  ready: boolean;
  /** Recorded viewport size (for fit-to-frame scaling). */
  size: { width: number; height: number } | null;
}

/**
 * Mount an rrweb `Replayer` into `root`, paused at the start. The library is
 * loaded on demand so the rest of the dashboard never pays for it; a new
 * event list tears the old instance down.
 */
export function useReplayerMount(
  events: unknown[],
  root: React.RefObject<HTMLDivElement | null>,
  onFinish: () => void,
): MountedReplayer {
  const ref = React.useRef<Replayer | null>(null);
  const [ready, setReady] = React.useState(false);
  const [size, setSize] = React.useState<MountedReplayer['size']>(null);
  const finish = React.useRef(onFinish);
  finish.current = onFinish;

  React.useEffect(() => {
    const el = root.current;
    if (!el || events.length < 2) return;
    let cancelled = false;
    let r: Replayer | null = null;
    void import('@rrweb/replay').then(({ Replayer: R }) => {
      if (cancelled) return;
      el.innerHTML = '';
      r = new R(events as RrEvents, {
        root: el,
        skipInactive: false,
        showWarning: false,
        mouseTail: false,
        triggerFocus: false,
      });
      r.on('resize', (d) => {
        const dim = d as { width: number; height: number };
        setSize({ width: dim.width, height: dim.height });
      });
      r.on('finish', () => finish.current());
      r.pause(0);
      ref.current = r;
      setReady(true);
    });
    return () => {
      cancelled = true;
      r?.destroy();
      ref.current = null;
      setReady(false);
    };
  }, [events, root]);

  return { ref, ready, size };
}
