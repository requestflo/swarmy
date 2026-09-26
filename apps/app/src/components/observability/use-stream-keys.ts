import * as React from 'react';
import { keyFromEvent, type NavAction, type NavLine } from './stream-keys';

/**
 * Binds the stream's keys on the window: j/k, Enter, e, space, Esc and / —
 * never while typing in a field or with a modifier held. Space and Enter on
 * some other button keep their native meaning.
 */
export function useStreamKeys(
  dispatch: React.Dispatch<NavAction>,
  lines: NavLine[],
  searchRef: React.RefObject<HTMLInputElement | null>,
): void {
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const key = keyFromEvent(e, { tag: el?.tagName ?? '', editable: !!el?.isContentEditable });
      if (!key) return;
      const onLine = !!el?.closest('[data-line]');
      const onOtherControl = !onLine && !!el?.closest('button, a, [role="tab"], summary');
      if ((key === 'pause' || key === 'open') && onOtherControl) return;
      // A focused line's Enter is its own click; don't toggle it twice.
      if (key === 'open' && onLine) return;
      if (key === 'close' && el === searchRef.current) {
        searchRef.current?.blur();
        return;
      }
      e.preventDefault();
      if (key === 'search') {
        searchRef.current?.focus();
        return;
      }
      dispatch({ kind: 'key', key, lines: linesRef.current });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, searchRef]);
}
