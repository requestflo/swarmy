import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { InvService } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

/** Tails the new service through the same `services.logs` stream the service page uses. */
function Tail({ serviceId }: { serviceId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const box = React.useRef<HTMLDivElement>(null);
  useSubscription(
    trpc.services.logs.subscriptionOptions(
      { serviceId, tail: 100, follow: true },
      { onData: (l: LogLine) => setLines((prev) => [...prev.slice(-400), l]) },
    ),
  );
  React.useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <div ref={box} tabIndex={0} aria-label="Log output" className="calm-code max-h-72 overflow-auto px-4 py-3 text-xs leading-relaxed">
      {lines.length === 0 ? (
        <p className="opacity-70">Waiting for its first lines…</p>
      ) : (
        lines.map((l, i) => (
          <pre key={`${l.seq}-${i}`} className={cn('whitespace-pre-wrap break-words', l.stream === 'stderr' && 'text-tone-bad')}>
            {l.message}
          </pre>
        ))
      )}
    </div>
  );
}

/**
 * "Show live log": closed by default (the tracker is the story). A service
 * with no running copy has nothing to tail yet, so it says so instead of
 * opening an empty stream.
 */
export function DeployingLog({ service, server }: { service: InvService | null; server: string | null }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const started = Boolean(service && service.replicas.running > 0);
  return (
    <section aria-label="Live log" className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="text-foreground hover:text-foreground/80 flex min-h-11 w-fit items-center gap-2 text-[14px] font-semibold"
      >
        <ChevronDownIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
        {open ? 'Hide live log' : 'Show live log'}
        {open && started && server ? <span className="text-muted-foreground font-mono text-[11.5px] font-normal">streaming from {server}</span> : null}
      </button>
      {open ? (
        <div id={id}>
          {service && started ? (
            <Tail serviceId={service.id} />
          ) : (
            <p className="calm-card text-muted-foreground px-4 py-3 text-[13px]">Logs appear once it starts.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
