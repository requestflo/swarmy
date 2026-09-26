import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { InvService } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DeployEventLog } from './deploy-event-log';
import type { DeployEvent } from './deploy-events';

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
 * "Show live log": closed by default (the tracker is the story). It shows
 * the deploy's own events (pull, data, start, certificate, health) and,
 * once the service has a running copy, its own log tailed below them.
 * Without a traced deploy it falls back to the tail alone.
 */
export function DeployingLog({
  service,
  server,
  events,
  streaming,
}: {
  service: InvService | null;
  server: string | null;
  events: DeployEvent[];
  streaming: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const started = Boolean(service && service.replicas.running > 0);
  const note = (streaming || started) && server ? `streaming from ${server}` : null;
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
        {open && note ? <span className="text-muted-foreground font-mono text-[11.5px] font-normal">{note}</span> : null}
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-3">
          {events.length ? <DeployEventLog events={events} /> : null}
          {service && started ? (
            <>
              {events.length ? <p className="text-muted-foreground font-mono text-[11.5px]">{service.name} · its own log</p> : null}
              <Tail serviceId={service.id} />
            </>
          ) : events.length ? null : (
            <p className="calm-card text-muted-foreground px-4 py-3 text-[13px]">Logs appear once it starts.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
