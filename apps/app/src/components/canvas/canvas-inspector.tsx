import * as React from 'react';
import { useReactFlow } from '@xyflow/react';
import { cn } from '@swarmy/ui';

const SPRING = 'duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]';

interface CanvasInspectorProps {
  /** Whether a node is selected — docks the panel in; false collapses it. */
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}

/**
 * The docked inspector column for the canvas: a real flex layout sibling
 * (never an overlay/portal) that slides in from the right when a service or
 * db-cluster node is selected, and collapses back to zero width on close.
 * Esc closes it; the canvas re-fits once the width settles.
 */
export function CanvasInspector({ open, onClose, children }: CanvasInspectorProps): React.JSX.Element {
  const { fitView } = useReactFlow();

  React.useEffect(() => {
    const t = setTimeout(() => fitView({ duration: 300, padding: 0.25, maxZoom: 1 }), 320);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={cn(
        'bg-card h-full shrink-0 overflow-hidden border-l transition-[width]',
        SPRING,
        open ? 'w-[400px]' : 'w-0',
      )}
    >
      <div className={cn('flex h-full w-[400px] flex-col transition-transform', SPRING, open ? 'translate-x-0' : 'translate-x-full')}>
        {children}
      </div>
    </div>
  );
}
