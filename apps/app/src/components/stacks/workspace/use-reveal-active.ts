import * as React from 'react';

/**
 * Keeps a sideways-scrolling tab strip's current tab in view (phone width):
 * scrolls the strip itself, never the page. Give the strip `relative` so its
 * links measure from it.
 */
export function useRevealActive<T extends HTMLElement>(key: string | undefined): React.RefObject<T | null> {
  const ref = React.useRef<T>(null);
  React.useLayoutEffect(() => {
    const nav = ref.current;
    const on = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !on) return;
    const left = on.offsetLeft;
    const right = left + on.offsetWidth;
    if (left < nav.scrollLeft || right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, left - 16);
  }, [key]);
  return ref;
}
