import * as React from 'react';

/** True when the viewport is below the `lg` (1024px) breakpoint. */
export function useBelowLg(): boolean {
  const [below, setBelow] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023.98px)');
    const update = () => setBelow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return below;
}
