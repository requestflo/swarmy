import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, cn, toast } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { MEMORY_CHOICES, memoryChangeWords, memoryWord } from './pg-memory';
import type { PgDetailCluster } from './use-pg-detail';

/**
 * The memory picker (Controls): pick a size, read what it restarts, then
 * apply (`db.setMemory`). It only declares the size; the reconcile restarts
 * the standby copies first, then the main copy in place.
 */
export function PgMemoryControl({ stack, c }: { stack: string; c: PgDetailCluster }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const current = c.memoryMb ?? null;
  const [picked, setPicked] = React.useState<number | null | undefined>(undefined);
  const copies = c.members.filter((m) => m.role !== 'dcs').reduce((n, m) => n + Math.max(1, m.desired), 0);
  const set = useMutation(
    trpc.db.setMemory.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.changed ? memoryChangeWords(c.name, r.memoryMb, r.restarts) : `${c.name} is already at ${memoryWord(r.memoryMb)}`);
        setPicked(undefined);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const choices = [...new Set([...MEMORY_CHOICES, current])].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const shown = picked === undefined ? current : picked;
  return (
    <Depth at="controls">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="Memory per copy" className="flex flex-wrap gap-1">
          {choices.map((m) => (
            <button
              key={m ?? 'none'}
              type="button"
              aria-pressed={m === shown}
              disabled={set.isPending}
              onClick={() => setPicked(m === current ? undefined : m)}
              className={cn(
                'min-h-9 rounded-lg border px-2.5 font-mono text-[12px] pointer-coarse:min-h-11',
                m === shown ? 'bg-muted border-foreground/30 font-semibold' : 'hover:bg-muted/50',
              )}
            >
              {memoryWord(m)}
            </button>
          ))}
        </div>
        {picked !== undefined ? (
          <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
            <p className="text-[13px]">{memoryChangeWords(c.name, picked, copies)}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={set.isPending} onClick={() => set.mutate({ stack, cluster: c.name, memoryMb: picked })}>
                {set.isPending ? 'Saving…' : `Restart onto ${memoryWord(picked)}`}
              </Button>
              <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setPicked(undefined)}>
                Keep {memoryWord(current)}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Depth>
  );
}
