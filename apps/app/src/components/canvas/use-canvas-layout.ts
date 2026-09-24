import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { Viewport } from '@xyflow/react';
import { useTRPC } from '@/integrations/trpc';

type Positions = Record<string, { x: number; y: number }>;

const VIEWPORT_KEY = 'swarmy.canvas.viewport';

function readViewport(): Viewport | null {
  try {
    const raw = window.localStorage.getItem(VIEWPORT_KEY);
    return raw ? (JSON.parse(raw) as Viewport) : null;
  } catch {
    return null;
  }
}

function writeViewport(v: Viewport): void {
  try {
    window.localStorage.setItem(VIEWPORT_KEY, JSON.stringify(v));
  } catch {
    // storage unavailable (private window) — the viewport is a convenience
  }
}

/**
 * Load + persist the org's canvas layout (drag = visual only). Positions are
 * saved server-side (debounced; they live in the org's swarm) so the canvas
 * reopens as the user left it on any device. The viewport is a per-viewer
 * preference kept in this browser — it changes on every pan/zoom.
 */
export function useCanvasLayout() {
  const trpc = useTRPC();
  const layout = useQuery(trpc.canvas.get.queryOptions());
  const save = useMutation(trpc.canvas.save.mutationOptions());

  const positionsRef = React.useRef<Positions>({});
  const [savedViewport] = React.useState<Viewport | null>(readViewport);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (layout.data) {
      positionsRef.current = layout.data.positions ?? {};
    }
  }, [layout.data]);

  const flush = React.useCallback(() => {
    save.mutate({ positions: positionsRef.current });
  }, [save]);

  // Keep the latest flush reachable from the unmount-only cleanup below without
  // re-running that effect on every render (flush identity changes each render).
  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  const queueSave = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  }, [flush]);

  const setPosition = React.useCallback(
    (id: string, x: number, y: number) => {
      positionsRef.current = { ...positionsRef.current, [id]: { x, y } };
      queueSave();
    },
    [queueSave],
  );

  const setViewport = React.useCallback((v: Viewport) => writeViewport(v), []);

  // On unmount, flush any pending (debounced) save so a drag-then-navigate within
  // the debounce window isn't lost.
  React.useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        flushRef.current();
      }
    },
    [],
  );

  return {
    isLoaded: layout.isSuccess,
    positions: layout.data?.positions ?? {},
    savedViewport,
    setPosition,
    setViewport,
  };
}
