import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, TONE_DOT, TONE_TEXT, Tech, useDepth } from '@/components/calm';
import { askThen, askTitle, askWhen, type AskDecision } from './edge-certs-model';

/** Rows at Summary; Controls shows every row the controller kept for the org. */
const SUMMARY_ROWS = 5;

/**
 * The on-demand ask log (board 31): the edge's question for each host it
 * has never seen, the controller's answer, and what that meant for the
 * certificate — "why didn't my domain get a certificate". In controller
 * memory, bounded; repeats fold into one row.
 */
export function AskLog({ log }: { log: readonly AskDecision[] }): React.JSX.Element {
  const controls = useDepth().atLeast('controls');
  const rows = controls ? log : log.slice(0, SUMMARY_ROWS);
  return (
    <div className="flex flex-col gap-1.5 pl-12">
      <h3 className="text-[13px] font-semibold">{askTitle(log)}</h3>
      {log.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">When a visit reaches an address with no certificate yet, the edge asks here first, and the answer shows up in this list.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((a) => {
            const tone = a.allowed ? 'ok' : a.why === 'dns-pending' ? 'warn' : 'idle';
            return (
              <li key={`${a.host}-${a.why}`} className="border-border flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b py-1.5 text-[12.5px] last:border-b-0">
                <span aria-hidden className={cn('size-1.5 shrink-0 self-center rounded-full', TONE_DOT[tone])} />
                <span className="min-w-0 font-mono text-[12px] break-all">{a.host}</span>
                <Depth at="controls">
                  <span className="text-muted-foreground font-mono text-[11px]">→ /ingress/ask →</span>
                </Depth>
                <span className={cn('font-mono text-[11.5px] font-semibold', TONE_TEXT[tone])}>{a.status}</span>
                <span className="text-muted-foreground min-w-0 flex-1">{askThen(a)}</span>
                <span className="text-muted-foreground font-mono text-[11px]">{askWhen(a)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!controls && log.length > SUMMARY_ROWS ? <p className="text-muted-foreground text-[12px]">{log.length - SUMMARY_ROWS} more at Controls.</p> : null}
      <Tech>ingress.askLog · the latest answers of GET /ingress/ask for your hosts, in controller memory (bounded, repeats folded) · 200 lets the edge order a certificate</Tech>
    </div>
  );
}
