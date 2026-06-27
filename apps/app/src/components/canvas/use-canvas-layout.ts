import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { Viewport } from '@xyflow/react';
import { useTRPC } from '@/integrations/trpc';

type Positions = Record<string, { x: number; y: number }>;

/**
 * Load + persist the org's canvas layout (drag = visual only). Positions and the
 * last viewport are saved server-side (debounced) so the canvas reopens exactly
 * where the user left it, on any device.
 */
export function useCanvasLayout() {
  const trpc = useTRPC();
  const layout = useQuery(trpc.canvas.get.queryOptions());
  const save = useMutation(trpc.canvas.save.mutationOptions());

  const positionsRef = React.useRef<Positions>({});
  const viewportRef = React.useRef<Viewport | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (layout.data) {
      positionsRef.current = layout.data.positions ?? {};
      viewportRef.current = layout.data.viewport ?? null;
    }
  }, [layout.data]);

  const flush = React.useCallback(() => {
    save.mutate({ positions: positionsRef.current, viewport: viewportRef.current });
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

  const setViewport = React.useCallback(
    (v: Viewport) => {
      viewportRef.current = v;
      queueSave();
    },
    [queueSave],
  );

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
    savedViewport: layout.data?.viewport ?? null,
    setPosition,
    setViewport,
  };
}
