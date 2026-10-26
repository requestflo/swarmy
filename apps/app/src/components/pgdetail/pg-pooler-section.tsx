import * as React from 'react';
import { CopyButton, cn } from '@swarmy/ui';
import { Depth, Section, StatusWord, TONE_TEXT, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { PgPoolerApps } from './pg-pooler-apps';
import { PgPoolerControl } from './pg-pooler-control';
import { MODE_WORDS, poolerHeadline, poolerTech, trafficLine } from './pg-pooler-words';
import type { PgDetailData } from './use-pg-detail';
import { usePgPooler } from './use-pg-pooler';

/**
 * Connection pooler (board 39, "PgBouncer"): whether one runs in front of the
 * main copy, how it's doing and how many clients it carries; what transaction
 * mode breaks, said plainly; at Controls the toggle, mode, pool size and which
 * apps go through it. Docker is the truth (`swarmy.db.pooler`, the
 * `<stack>_<cluster>-pooler` service); the reconcile converges it.
 */
export function PgPoolerSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const c = d.cluster!;
  const p = usePgPooler(stack, c.name);
  const v = p.view;
  if (!v) {
    return (
      <Section title="Connection pooler" hint="PgBouncer, in front of the main copy">
        {p.pending ? <CardSkeleton /> : <p className="text-muted-foreground text-[13px]">Couldn’t read the pooler: {p.error?.message ?? 'unknown error'}.</p>}
      </Section>
    );
  }
  const head = poolerHeadline(v);
  const through = v.apps.filter((a) => a.via === 'pooler').length;
  return (
    <Section title="Connection pooler" hint="PgBouncer, in front of the main copy">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <StatusWord tone={head.tone} word={head.word} pulse={head.tone === 'info'} />
          <p className="text-[13.5px]" aria-live="polite">
            {head.sentence}
          </p>
          {v.declared ? (
            <p className="text-muted-foreground text-[13px]">
              {trafficLine(v.traffic, v.declared.poolSize)} · {through} of {v.apps.length} {v.apps.length === 1 ? 'app goes' : 'apps go'} through it
            </p>
          ) : null}
        </div>
        {v.declared ? (
          <>
            <p className={cn('text-[13px]', v.declared.mode === 'transaction' ? TONE_TEXT.warn : 'text-muted-foreground')}>
              {MODE_WORDS[v.declared.mode].label} mode. {MODE_WORDS[v.declared.mode].sentence}
            </p>
            <div className="flex items-center gap-2">
              <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[12px]">{v.address}</code>
              <CopyButton value={v.address} aria-label="Copy the pooler address" className="size-9 shrink-0" />
            </div>
          </>
        ) : null}
        <Tech>{poolerTech(v)}</Tech>
        <Depth at="controls">
          <PgPoolerApps v={v} p={p} />
        </Depth>
        <PgPoolerControl v={v} p={p} />
      </div>
    </Section>
  );
}
