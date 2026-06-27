import { cn } from '@swarmy/ui';

/** swarm + coral "y". On the navy sidenav, text is light; the y is always coral. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display text-xl font-bold tracking-tight', className)}>
      swarm<span className="text-primary">y</span>
    </span>
  );
}
