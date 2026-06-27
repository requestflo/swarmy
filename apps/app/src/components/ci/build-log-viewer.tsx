import * as React from 'react';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * Live build-log viewer (epic: git-cicd-registry, PHASE-2).
 *
 * Seeds from the historical `buildLogPage` scrollback, then tails the
 * `buildLogs` subscription (fed by the build's `logChunk`s over the existing log
 * plumbing, keyed by build id). Auto-scrolls while pinned to the bottom.
 */
export interface BuildLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

export function BuildLogViewer({
  buildId,
  live,
}: {
  buildId: string;
  /** When false (build already finished) we skip the live subscription. */
  live: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const [lines, setLines] = React.useState<BuildLogLine[]>([]);
  const seen = React.useRef<Set<number>>(new Set());
  const boxRef = React.useRef<HTMLDivElement>(null);
  const pinnedRef = React.useRef(true);

  const append = React.useCallback((incoming: BuildLogLine[]) => {
    setLines((prev) => {
      const next = [...prev];
      for (const l of incoming) {
        // De-dup across the page-seed/replay + live overlap (seq is per-stream).
        const key = l.seq * 2 + (l.stream === 'stderr' ? 1 : 0);
        if (seen.current.has(key)) continue;
        seen.current.add(key);
        next.push(l);
      }
      return next;
    });
  }, []);

  // Seed scrollback once.
  const page = useQuery(trpc.cicd.buildLogPage.queryOptions({ buildId }));
  React.useEffect(() => {
    if (page.data?.lines) append(page.data.lines);
  }, [page.data, append]);

  // Tail live output while the build is running.
  useSubscription(
    trpc.cicd.buildLogs.subscriptionOptions(
      { buildId },
      {
        enabled: live,
        onData: (line: BuildLogLine) => append([line]),
      },
    ),
  );

  // Auto-scroll while pinned to the bottom.
  React.useEffect(() => {
    const box = boxRef.current;
    if (box && pinnedRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  };

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      className="bg-foreground/95 text-background h-[60vh] overflow-auto rounded-xl p-4 font-mono text-xs leading-relaxed"
    >
      {lines.length === 0 ? (
        <p className="text-background/50">{live ? 'Waiting for build output…' : 'No logs captured.'}</p>
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
  );
}
