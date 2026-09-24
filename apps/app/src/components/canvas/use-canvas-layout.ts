import * as React from 'react';
import type { Viewport } from '@xyflow/react';

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
 * The canvas viewport (pan/zoom) is a per-viewer preference kept in this
 * browser. Card positions are Docker truth — `swarmy.canvas.x/y` service labels
 * written via `services.setCanvasPos` — so nothing here touches the server.
 */
export function useCanvasLayout() {
  const [savedViewport] = React.useState<Viewport | null>(readViewport);
  const setViewport = React.useCallback((v: Viewport) => writeViewport(v), []);
  return { savedViewport, setViewport };
}
