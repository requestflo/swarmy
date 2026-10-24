import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, cn, toast } from '@swarmy/ui';
import { Depth, TONE_TEXT, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { testLine } from './probe-model';

/**
 * "Test now" (board AppRollout): the saved check, run once inside the
 * newest running copy on the server hosting it (container exec, audited),
 * with its result, exit code and time. Output shows at Controls.
 */
export function HealthTest({ id, name, unsaved }: { id: string; name: string; unsaved: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const run = useMutation(trpc.services.testHealthcheck.mutationOptions({ onError: (e) => toast.error(e.message) }));
  const r = run.data;
  return (
    <div className="border-border flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate({ id })} className="pointer-coarse:min-h-11">
          {run.isPending ? 'Testing…' : 'Test now'}
        </Button>
        <span aria-live="polite" className={cn('text-[13px]', r ? TONE_TEXT[r.ok ? 'ok' : 'bad'] : 'text-muted-foreground')}>
          {run.isPending
            ? `Asking one of ${name}’s copies…`
            : r
              ? testLine(r)
              : `Runs ${name}’s saved check once in a running copy and says what it answered.${unsaved ? ' Save first to test your changes.' : ''}`}
        </span>
      </div>
      {r ? (
        <Depth at="controls">
          {r.output ? <pre className="calm-code max-h-40 overflow-auto rounded-lg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{r.output}</pre> : null}
          <Tech>
            exit {r.exitCode ?? '—'} · {r.durationMs} ms{r.timedOut ? ' · timed out' : ''} · container {r.containerId.slice(0, 12)}
            {r.node ? ` on ${r.node}` : ''} · {r.cmd.join(' ')}
          </Tech>
        </Depth>
      ) : null}
    </div>
  );
}
