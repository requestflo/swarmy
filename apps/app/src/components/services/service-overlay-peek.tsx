import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { DeckEntry } from './use-service-deck';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-status-online',
  degraded: 'bg-status-warning',
  deploying: 'bg-status-progress',
  idle: 'bg-status-idle',
  stopped: 'bg-status-idle',
};

interface ServiceOverlayPeekProps {
  side: 'left' | 'right';
  entry: DeckEntry;
  onClick: () => void;
}

/**
 * A coverflow neighbour peeking from behind the overlay panel's edge — tilted
 * in 3D, sliding out a touch on hover. Desktop only; the arrows and ←/→ keys
 * cover mobile.
 */
export function ServiceOverlayPeek({ side, entry, onClick }: ServiceOverlayPeekProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${entry.name}`}
      className={cn(
        'group absolute top-1/2 z-[5] hidden -translate-y-1/2 cursor-pointer [perspective:900px] lg:block',
        side === 'left' ? 'left-1.5' : 'right-1.5',
      )}
    >
      <div
        className={cn(
          'card-pop w-44 rounded-2xl p-4 opacity-90 shadow-xl transition-transform duration-300',
          side === 'left'
            ? '[transform:rotateY(16deg)] group-hover:[transform:rotateY(10deg)_translateX(6px)]'
            : '[transform:rotateY(-16deg)] group-hover:[transform:rotateY(-10deg)_translateX(-6px)]',
        )}
      >
        <p className="mono-label text-muted-foreground !mb-1.5">{side === 'left' ? '← previous' : 'next →'}</p>
        <p className="flex items-center gap-2 text-sm font-bold">
          <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[entry.status] ?? 'bg-status-idle')} />
          <span className="truncate">{entry.name}</span>
        </p>
      </div>
    </button>
  );
}
