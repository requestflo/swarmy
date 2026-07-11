import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { useSubscription } from '@trpc/tanstack-react-query';
import { Button, Card, CardContent, cn } from '@swarmy/ui';
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
    <Card className={cn('card-pop border-0', className)}>
      <CardContent className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Live logs</p>
          <Button asChild variant="outline" size="sm" className="rounded-full">
            <Link to="/services/$serviceId/terminal" params={{ serviceId }}>
              <TerminalIcon className="size-4" /> Terminal
            </Link>
          </Button>
        </div>
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="bg-foreground/95 text-background h-[60vh] overflow-auto rounded-xl p-4 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="text-background/50">Waiting for log output…</p>
          ) : (
            lines.map((l, i) => (
              <pre
                key={`${l.stream}-${l.seq}-${i}`}
                className={l.stream === 'stderr' ? 'text-status-offline whitespace-pre-wrap' : 'whitespace-pre-wrap'}
              >
                {l.message}
              </pre>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
