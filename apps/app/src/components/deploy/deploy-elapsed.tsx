import * as React from 'react';

export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** `Date.now()`, re-read every second while mounted. */
export function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The top bar's ticking "0:28 elapsed", from when the deploy started. */
export function Elapsed({ since }: { since: number }): React.JSX.Element {
  const now = useNow();
  return (
    <span className="text-muted-foreground font-mono text-[12px]" aria-live="off">
      {clock(Math.max(0, Math.round((now - since) / 1000)))} elapsed
    </span>
  );
}
