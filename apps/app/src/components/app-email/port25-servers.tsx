import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn, toast } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import { useTRPC } from '@/integrations/trpc';

type State = 'open' | 'blocked' | 'timeout' | 'unknown' | 'untested' | 'offline' | 'unsupported';

const TONE: Record<State, Tone> = { open: 'ok', blocked: 'bad', timeout: 'bad', unknown: 'warn', untested: 'idle', offline: 'idle', unsupported: 'idle' };
const WORD: Record<State, string> = {
  open: 'Open',
  blocked: 'Blocked',
  timeout: 'Timed out',
  unknown: 'Unclear',
  untested: 'Not tested',
  offline: 'Offline',
  unsupported: 'Update agent',
};

/**
 * Board 66's per-server test: each server tries one connection to a big
 * mail host on port 25 (no mail is sent) and says open, blocked or timed
 * out, so you know where direct delivery could work.
 */
export function Port25Servers(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.email.port25Servers.queryOptions());
  const test = useMutation(
    trpc.email.testPort25Servers.mutationOptions({
      onSuccess: (rows) => qc.setQueryData(trpc.email.port25Servers.queryKey(), rows),
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = q.data;
  if (!rows || rows.length === 0) return null;
  const askable = rows.some((r) => r.state !== 'offline' && r.state !== 'unsupported');
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground max-w-[60ch] text-[13px] leading-relaxed">
          Many clouds (including DigitalOcean) block outbound port 25, and fresh IPs land in spam. A relay you trust is often the honest choice.
        </p>
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={!askable || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Testing each server…' : 'Test port 25 on each server'}
        </Button>
      </div>
      <ul className="flex flex-col" aria-label="Port 25 on each server">
        {rows.map((r) => {
          const tone = TONE[r.state as State] ?? 'idle';
          return (
            <li key={r.nodeId} className="border-border flex items-start gap-3 border-b py-2 last:border-b-0">
              <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13.5px] font-semibold">{r.name}</span>
                <span className="text-muted-foreground text-[13px] leading-snug">{r.words}</span>
                {r.target ? (
                  <Tech>{`${r.target}${r.ms !== null ? ` · ${r.ms} ms` : ''}${r.at ? ` · ${relTime(new Date(r.at))}` : ''}`}</Tech>
                ) : null}
              </span>
              <span className={cn('shrink-0 text-xs font-semibold', TONE_TEXT[tone])}>{WORD[r.state as State] ?? r.state}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
