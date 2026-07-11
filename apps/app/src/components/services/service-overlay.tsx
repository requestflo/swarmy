import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { ServicePageBody } from './service-page-body';
import { ServiceOverlayPeek } from './service-overlay-peek';
import type { ServiceTab } from './service-section-strip';
import { useServiceDeck } from './use-service-deck';

interface ServiceOverlayProps {
  serviceId: string;
  /** Screen position of the tapped canvas node — the panel zooms out of it. */
  origin: { x: number; y: number } | null;
  onClose: () => void;
  onSwitch: (id: string) => void;
}

/**
 * Tap a container on the canvas and you're transported inside it: a 90%
 * dialog that zooms out of the tapped node, with the canvas still visible
 * behind. The stack's sibling services form a coverflow deck — peek cards at
 * the edges, ←/→ keys, and the data-flow strip all jump between them.
 */
export function ServiceOverlay({ serviceId, origin, onClose, onSwitch }: ServiceOverlayProps): React.JSX.Element {
  const { deck, index, prev, next } = useServiceDeck(serviceId);
  const [tab, setTab] = React.useState<ServiceTab>('inside');
  // Slide direction for the coverflow transition, derived from deck movement.
  const lastIndex = React.useRef(index);
  const dir = index >= 0 && lastIndex.current >= 0 && index !== lastIndex.current
    ? index > lastIndex.current ? 'left' : 'right'
    : null;
  React.useEffect(() => {
    if (index >= 0) lastIndex.current = index;
  }, [index]);

  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev) onSwitch(prev.id);
      else if (e.key === 'ArrowRight' && next) onSwitch(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSwitch, prev, next]);

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="overlay-backdrop-in bg-ink/55 absolute inset-0 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />

      {prev ? <ServiceOverlayPeek side="left" entry={prev} onClick={() => onSwitch(prev.id)} /> : null}
      {next ? <ServiceOverlayPeek side="right" entry={next} onClick={() => onSwitch(next.id)} /> : null}

      <div className="pointer-events-none absolute inset-0 grid place-items-center [perspective:1600px]">
        <div
          role="dialog"
          aria-modal="true"
          className="overlay-zoom-in border-border bg-background pointer-events-auto relative flex h-[90dvh] w-[92vw] max-w-[1440px] flex-col overflow-hidden rounded-3xl border shadow-2xl"
          style={{ transformOrigin: origin ? `${origin.x}px ${origin.y}px` : 'center' }}
        >
          <div className="absolute top-4 right-4 z-10 flex items-center gap-1.5">
            {deck.length > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous service"
                  disabled={!prev}
                  onClick={() => prev && onSwitch(prev.id)}
                  className="border-border bg-card hover:bg-accent grid size-9 cursor-pointer place-items-center rounded-full border shadow-sm transition-colors disabled:opacity-35"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
                <span className="mono-data text-muted-foreground px-1 text-xs">
                  {index + 1}/{deck.length}
                </span>
                <button
                  type="button"
                  aria-label="Next service"
                  disabled={!next}
                  onClick={() => next && onSwitch(next.id)}
                  className="border-border bg-card hover:bg-accent grid size-9 cursor-pointer place-items-center rounded-full border shadow-sm transition-colors disabled:opacity-35"
                >
                  <ChevronRightIcon className="size-4" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="bg-ink text-ink-foreground ml-1 grid size-9 cursor-pointer place-items-center rounded-full shadow-md transition-transform hover:scale-105"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          <div
            key={serviceId}
            className={cn(
              'flex-1 overflow-y-auto px-5 pt-5 pb-8 sm:px-8 sm:pt-6',
              dir === 'left' && 'overlay-slide-left',
              dir === 'right' && 'overlay-slide-right',
            )}
          >
            <ServicePageBody
              serviceId={serviceId}
              tab={tab}
              onTabChange={setTab}
              onSelectService={onSwitch}
              compact
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
