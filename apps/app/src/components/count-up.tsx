import * as React from 'react';

/**
 * Animated count-up for hero numbers. Respects prefers-reduced-motion.
 *
 * It animates only between two real values: the first render paints `value`
 * as-is (no run-up from 0), and a refetch that returns the same number does
 * nothing. Callers must not mount it with a placeholder (`data?.n ?? 0`) —
 * draw a skeleton until the number exists, then mount this.
 */
export function CountUp({
  value,
  durationMs = 700,
  className,
  format = (n) => `${Math.round(n)}`,
}: {
  value: number;
  durationMs?: number;
  className?: string;
  format?: (n: number) => string;
}): React.JSX.Element {
  const [display, setDisplay] = React.useState(value);
  // What is on screen right now — the origin of the next animation, so an
  // interrupted run continues from where it was rather than jumping.
  const shownRef = React.useRef(value);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    const reduce =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      shownRef.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const next = t < 1 ? from + (value - from) * eased : value;
      shownRef.current = next;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
}
