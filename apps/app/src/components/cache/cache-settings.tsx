import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn, toast } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { bytes } from '@/lib/format';
import { PERSISTENCE, evictionWords, type CacheView } from './cache-words';

const MB = 1024 * 1024;
const CHOICES = [128, 256, 512, 1024, 2048, 4096];
const fmtMb = (m: number): string => (m >= 1024 ? `${m / 1024} GB` : `${m} MB`);

function Kv({ k, children, tech }: { k: string; children: React.ReactNode; tech?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1 border-t py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-muted-foreground w-28 shrink-0 text-[13px]">{k}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {tech ? <Tech>{tech}</Tech> : null}
      </div>
    </div>
  );
}

/** Memory limit: what's used of the cap; the cap itself at Controls (`cache.setMemory`). */
function MemoryRow({ v }: { v: CacheView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.cache.setMemory.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${v.name} → ${fmtMb(r.memoryMb)} · its members restart onto it`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const used = v.stats?.usedMemoryBytes ?? null;
  const pct = used !== null ? Math.min(100, (used / (v.memoryMb * MB)) * 100) : null;
  return (
    <Kv k="Memory limit" tech={`maxmemory ${v.memoryMb}mb · the swarm limit adds 64 MB headroom · swarmy.cache.memoryMb`}>
      <div className="flex items-center gap-3">
        <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full" aria-hidden>
          <div className={cn('h-full rounded-full', pct !== null && pct > 90 ? 'bg-status-offline' : pct !== null && pct > 75 ? 'bg-status-warning' : 'bg-status-online')} style={{ width: `${pct ?? 0}%` }} />
        </div>
        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
          {used !== null ? `${bytes(used)} of ${fmtMb(v.memoryMb)}` : `up to ${fmtMb(v.memoryMb)}`}
        </span>
      </div>
      <Depth at="controls">
        <div role="group" aria-label="Memory limit" className="flex flex-wrap gap-1">
          {[...new Set([...CHOICES, v.memoryMb])].sort((a, b) => a - b).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === v.memoryMb}
              disabled={set.isPending}
              onClick={() => m !== v.memoryMb && set.mutate({ stack: v.stack, cluster: v.name, memoryMb: m })}
              className={cn('min-h-9 rounded-lg border px-2.5 font-mono text-[12px] pointer-coarse:min-h-11', m === v.memoryMb ? 'bg-muted border-foreground/30 font-semibold' : 'hover:bg-muted/50')}
            >
              {fmtMb(m)}
            </button>
          ))}
        </div>
      </Depth>
    </Kv>
  );
}

/**
 * A cache's settings as the board lays them out: memory limit, when full,
 * persistence and hit rate. Eviction and persistence are fixed by swarmy
 * (cache.service), so they read as facts, never as pickers.
 */
export function CacheSettings({ v }: { v: CacheView }): React.JSX.Element {
  const evict = evictionWords(v);
  const s = v.stats;
  return (
    <div className="flex flex-col">
      <MemoryRow v={v} />
      <Kv k="When full" tech={evict.tech}>
        <span className="text-[13px]">It {evict.say}.</span>
      </Kv>
      <Kv k="Persistence" tech={PERSISTENCE.tech}>
        <span className="text-[13px]">On: {PERSISTENCE.say}.</span>
      </Kv>
      <Kv k="Hit rate" tech={s ? `INFO keyspace_hits / (hits + misses) · sampled ${new Date(s.at).toLocaleTimeString()} · swarmy.cache.stats` : undefined}>
        <span className="text-[13px]">
          {s?.hitRatePct != null ? (
            <>
              <b className="font-semibold">{Math.round(s.hitRatePct)}%</b> of lookups found what they asked for
            </>
          ) : s ? 'No lookups yet' : 'Not sampled yet'}
          {s ? <span className="text-muted-foreground"> · {s.opsPerSec.toLocaleString()} ops/s · {s.keys.toLocaleString()} keys right now</span> : null}
        </span>
      </Kv>
    </div>
  );
}
