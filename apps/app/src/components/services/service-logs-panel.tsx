import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { useSubscription } from '@trpc/tanstack-react-query';
import { Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ServiceLogsPanelProps {
  serviceId: string;
  className?: string;
}

interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Live service logs. Tails the Docker-direct `services.logs` subscription — the
 * controller resolves the service + a manager from the live inventory (no DB) and
 * relays `docker service logs` from the node agent. Auto-scrolls while pinned.
 */
export function ServiceLogsPanel({ serviceId, className }: ServiceLogsPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const pinnedRef = React.useRef(true);

  useSubscription(
    trpc.services.logs.subscriptionOptions(
      { serviceId, tail: 200, follow: true },
      { onData: (line: LogLine) => setLines((prev) => [...prev.slice(-2000), line]) },
    ),
  );

  React.useEffect(() => {
    const box = boxRef.current;
    if (box && pinnedRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const box = boxRef.current;
    if (!box) return;
    pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  };

  return (
    <section aria-label="Live logs" className={cn('calm-card px-5 py-4', className)}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">Live logs</h2>
          <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Link to="/services/$serviceId/terminal" params={{ serviceId }}>
              <TerminalIcon className="size-4" /> Terminal
            </Link>
          </Button>
        </div>
        <div
          ref={boxRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Log output"
          className="calm-code h-[60vh] overflow-auto px-4 py-3 text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="opacity-70">Waiting for log output…</p>
          ) : (
            lines.map((l, i) => (
              <pre
                key={`${l.stream}-${l.seq}-${i}`}
                className={l.stream === 'stderr' ? 'whitespace-pre-wrap text-[#ff9b9b]' : 'whitespace-pre-wrap'}
              >
                {l.message}
              </pre>
            ))
          )}
        </div>
    </section>
  );
}
