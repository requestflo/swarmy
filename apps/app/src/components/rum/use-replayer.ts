import * as React from 'react';
import { useReplayerMount } from './use-replayer-mount';

export interface ReplayerControls {
  ready: boolean;
  playing: boolean;
  time: number;
  speed: number;
  size: { width: number; height: number } | null;
  toggle: () => void;
  seek: (t: number) => void;
  setSpeed: (s: number) => void;
}

/**
 * Play / pause / seek / speed over a mounted rrweb Replayer. Time is polled
 * with rAF while playing — rrweb emits no tick events.
 */
export function useReplayer(
  events: unknown[],
  root: React.RefObject<HTMLDivElement | null>,
  total: number,
): ReplayerControls {
  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(0);
  const [speed, setSpeedState] = React.useState(1);
  const { ref, ready, size } = useReplayerMount(events, root, () => {
    setPlaying(false);
    setTime(total);
  });

  React.useEffect(() => {
    setTime(0);
    setPlaying(false);
  }, [events]);

  React.useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = (): void => {
      if (ref.current) setTime(Math.min(total, ref.current.getCurrentTime()));
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, total, ref]);

  const seek = (t: number): void => {
    const at = Math.max(0, Math.min(total, t));
    const r = ref.current;
    if (r) {
      if (playing) r.play(at);
      else r.pause(at);
    }
    setTime(at);
  };

  const toggle = (): void => {
    const r = ref.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
      return;
    }
    r.play(time >= total - 50 ? 0 : time);
    setPlaying(true);
  };

  const setSpeed = (s: number): void => {
    ref.current?.setConfig({ speed: s });
    setSpeedState(s);
  };

  return { ready, playing, time, speed, size, toggle, seek, setSpeed };
}
