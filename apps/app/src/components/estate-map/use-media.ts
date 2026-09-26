import * as React from 'react';

/** True while a media query matches (reduced motion, a touch pointer). SSR/test-safe: false. */
export function useMedia(query: string): boolean {
  const subscribe = React.useCallback(
    (cb: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** An element's size, tracked with a ResizeObserver (0 × 0 before the first measure). */
export function useSize<T extends HTMLElement>(): [React.RefCallback<T>, { w: number; h: number }] {
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const ro = React.useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    const read = (): void => setSize((p) => (p.w === el.offsetWidth && p.h === el.offsetHeight ? p : { w: el.offsetWidth, h: el.offsetHeight }));
    read();
    ro.current = new ResizeObserver(read);
    ro.current.observe(el);
  }, []);
  return [ref, size];
}
