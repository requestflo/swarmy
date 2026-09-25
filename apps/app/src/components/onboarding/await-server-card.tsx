import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { StatusWord } from '@/components/calm';
import type { AwaitedNode } from './use-await-node';

function useElapsed(running: boolean): string {
  const [start] = React.useState(() => Date.now());
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, [running]);
  const s = Math.floor((Date.now() - start) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The waiting-for-the-server pulse, then the arrival. */
export function AwaitServerCard({
  armed,
  arrived,
}: {
  armed: boolean;
  arrived: AwaitedNode | null;
}): React.JSX.Element {
  const elapsed = useElapsed(armed && !arrived);
  return (
    <section aria-live="polite" aria-label="New server" className="calm-card flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      {arrived ? (
        <>
          <StatusWord tone="ok" word="Online" />
          <h2 className="font-display text-[1.45rem] font-bold tracking-[-0.02em]">{arrived.name} joined.</h2>
          <p className="text-muted-foreground text-[13.5px]">It's ready for apps. swarmy starts placing work on it straight away.</p>
          <Button asChild className="pointer-coarse:min-h-11">
            <Link to="/nodes/$nodeId" params={{ nodeId: arrived.id }}>
              Open {arrived.name} <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        </>
      ) : (
        <>
          <span aria-hidden className="relative flex size-16 items-center justify-center">
            <span className="bg-primary/15 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none" />
            <span className="bg-primary relative size-3 rounded-full" />
          </span>
          <h2 className="font-display text-[1.3rem] font-bold tracking-[-0.02em]">
            {armed ? 'Waiting for it to phone home…' : 'Making your link…'}
          </h2>
          <p className="text-muted-foreground font-mono text-[12px]">
            {armed ? `listening · ${elapsed} · usually under 90 s` : 'one moment'}
          </p>
        </>
      )}
    </section>
  );
}
