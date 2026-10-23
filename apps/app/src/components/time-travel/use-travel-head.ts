import * as React from 'react';
import { NOW_MS, stepTo, WEEK_MS, type TravelEvent } from './time-travel-model';

export interface TravelHead {
  /** The moment the head is on (ms). */
  at: number;
  live: boolean;
  /** Put the head on a moment (clamped to the week; near now it follows now again). */
  go: (t: number) => void;
  step: (dir: 1 | -1) => void;
  toNow: () => void;
}

/** Keys that belong to whatever has focus: typing, a dialog, a tab strip. */
function ownsArrows(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return Boolean(el.closest('[role="dialog"],[role="alertdialog"],[role="tablist"],[role="radiogroup"],[role="listbox"],[role="menu"]'));
}

/**
 * The timeline head: where it is, dragging/jumping it, ←/→ between events
 * anywhere on the page, and Back to now. Live (null) follows the clock.
 */
export function useTravelHead(events: TravelEvent[], now: number): TravelHead {
  const [t, setT] = React.useState<number | null>(null);
  const at = t === null ? now : Math.min(now, Math.max(now - WEEK_MS, t));
  const clamp = React.useCallback((x: number) => Math.max(now - WEEK_MS, Math.min(now, x)), [now]);
  const go = React.useCallback((x: number) => setT(now - x < NOW_MS ? null : clamp(x)), [now, clamp]);
  // Stepping lands exactly on the event, even one seconds old, so ← never sticks at now.
  const step = React.useCallback(
    (dir: 1 | -1) => {
      const x = stepTo(events, at, dir, now);
      setT(dir === 1 && x >= now ? null : clamp(x));
    },
    [events, at, now, clamp],
  );
  const toNow = React.useCallback(() => setT(null), []);

  const stepRef = React.useRef(step);
  React.useEffect(() => {
    stepRef.current = step;
  }, [step]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || ownsArrows(e.target)) return;
      e.preventDefault();
      stepRef.current(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { at, live: t === null || now - at < NOW_MS, go, step, toNow };
}
