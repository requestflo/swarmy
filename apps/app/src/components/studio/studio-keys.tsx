import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { Button, Input, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { StudioKeyValue } from './studio-key-value';
import type { StudioKeyRow, StudioScope } from './studio-types';

function ttl(ms: number): string {
  if (ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} m` : s < 86_400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} d`;
}

const UNIT: Record<string, string> = { string: 'B', hash: 'fields', list: 'items', set: 'members', zset: 'members', stream: 'entries' };

/** Redis/Valkey key browser: SCAN pages (never KEYS), type / TTL / size, and the key's value. */
export function StudioKeys({ scope }: { scope: StudioScope }): React.JSX.Element {
  const trpc = useTRPC();
  const [pattern, setPattern] = React.useState('*');
  const [draft, setDraft] = React.useState('*');
  const [cursor, setCursor] = React.useState('0');
  const [acc, setAcc] = React.useState<StudioKeyRow[]>([]);
  const [sel, setSel] = React.useState<StudioKeyRow | null>(null);
  const q = useQuery(trpc.studio.keys.queryOptions({ stack: scope.stack, target: scope.target.name, dbIndex: scope.dbIndex, pattern, cursor, count: 200 }));
  React.useEffect(() => {
    if (!q.data) return;
    setAcc((prev) => (cursor === '0' ? q.data.keys : [...prev, ...q.data.keys.filter((k) => !prev.some((p) => p.key === k.key))]));
  }, [q.data, cursor]);
  React.useEffect(() => {
    setCursor('0');
    setSel(null);
  }, [pattern, scope.dbIndex, scope.target.name]);

  return (
    <div className="card-pop flex min-h-[28rem] flex-1 flex-col overflow-hidden border-0 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <form className="border-border flex items-center gap-2 border-b px-3 py-2" onSubmit={(e) => { e.preventDefault(); setPattern(draft.trim() || '*'); }}>
          <SearchIcon className="text-muted-foreground size-3.5" />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 max-w-xs font-mono text-xs" aria-label="Key pattern" />
          <Button size="sm" variant="outline" type="submit" className="h-7">Scan</Button>
          <span className="text-muted-foreground ml-auto font-mono text-[11px]">SCAN · 200 per page</span>
        </form>
        {q.isPending && acc.length === 0 ? <CardSkeleton /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="bg-muted sticky top-0 grid grid-cols-[1fr_5rem_4.5rem_6rem] gap-2 px-3 py-2 text-xs font-semibold">
              <span>key</span><span>type</span><span>ttl</span><span>size</span>
            </div>
            {acc.map((k) => (
              <button key={k.key} type="button" onClick={() => setSel(k)} className={cn('border-border hover:bg-accent/60 grid w-full grid-cols-[1fr_5rem_4.5rem_6rem] gap-2 border-b px-3 py-1.5 text-left font-mono text-xs', sel?.key === k.key && 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]')}>
                <span className="truncate">{k.key}</span><span>{k.type}</span><span>{ttl(k.ttlMs)}</span><span>{k.size} {UNIT[k.type] ?? ''}</span>
              </button>
            ))}
            {acc.length === 0 ? <p className="text-muted-foreground px-3 py-6 text-sm">No keys match {pattern}.</p> : null}
          </div>
        )}
        <div className="border-border flex items-center gap-2 border-t px-3 py-1.5">
          <span className="text-muted-foreground font-mono text-[11px]">{acc.length} keys loaded</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" disabled={!q.data || q.data.cursor === '0' || q.isFetching} onClick={() => q.data && setCursor(q.data.cursor)}>
            Load more
          </Button>
        </div>
      </div>
      {sel ? <StudioKeyValue scope={scope} row={sel} onClose={() => setSel(null)} onChanged={() => { setCursor('0'); void q.refetch(); }} /> : null}
    </div>
  );
}
