import * as React from 'react';
import '@rrweb/replay/dist/style.css';

interface ReplayViewportProps {
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** Recorded viewport size, once the Replayer reports it. */
  size: { width: number; height: number } | null;
  ready: boolean;
  url: string;
}

/** Track a box's content size. */
function useBoxSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setBox({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/**
 * The replayed page in a quiet browser frame. rrweb rebuilds the recorded DOM
 * in a sandboxed iframe at the visitor's viewport size; we scale it to fit.
 */
export function ReplayViewport({ stageRef, size, ready, url }: ReplayViewportProps): React.JSX.Element {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const box = useBoxSize(boxRef);
  const scale = size && box.w && box.h ? Math.min(box.w / size.width, box.h / size.height, 1) : 1;
  const left = size ? Math.max(0, (box.w - size.width * scale) / 2) : 0;

  return (
    <div className="border-border flex h-[420px] flex-col overflow-hidden rounded-2xl border bg-card lg:h-[500px]">
      <div className="bg-muted text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-b px-3 font-mono text-[11px]">
        <i className="bg-border size-2 rounded-full" />
        <i className="bg-border size-2 rounded-full" />
        <i className="bg-border size-2 rounded-full" />
        <span className="ml-2 truncate">{url || '—'}</span>
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden" aria-label="Replayed page">
        <div
          ref={stageRef}
          className="absolute top-0"
          style={{
            left,
            width: size?.width,
            height: size?.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
        {!ready ? <div className="shimmer-line absolute inset-0" aria-hidden /> : null}
        <span className="bg-ink/75 text-ink-foreground pointer-events-none absolute right-3 bottom-2.5 rounded-md px-2 py-0.5 font-mono text-[10.5px]">
          recorded DOM · not a video
        </span>
      </div>
    </div>
  );
}
