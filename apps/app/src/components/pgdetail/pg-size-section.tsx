import * as React from 'react';
import { Section, TONE_TEXT, Tech } from '@/components/calm';
import { cn } from '@swarmy/ui';
import { bytes } from '@/lib/format';
import { PgMemoryControl } from './pg-memory-control';
import { memoryLine } from './pg-memory';
import type { PgDetailData } from './use-pg-detail';

function Row({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0">
      <dt className="text-muted-foreground text-[13px]">{k}</dt>
      <dd className="flex min-w-0 flex-col gap-1.5">{children}</dd>
    </div>
  );
}

/**
 * Size (board 39, "Version & size"): memory per copy — what the main copy
 * uses now, the limit, and while it changes how far the rolling restart has
 * got; the picker at Controls (`db.setMemory`).
 */
export function PgSizeSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const c = d.cluster!;
  const running = c.primary.status === 'running';
  const m = memoryLine(c, running && d.usage ? d.usage.memBytes.peak : null);
  return (
    <Section title="Size">
      <dl className="-my-1 flex flex-col">
        <Row k="Memory">
          <p className="text-[13.5px]">
            <b className="font-semibold">{m.label}</b>
            <span className={cn('block text-[13px]', m.progress ? TONE_TEXT.info : 'text-muted-foreground')}>{m.hint}</span>
          </p>
          <Tech>{m.tech}</Tech>
          {d.usage && running ? (
            <Tech>
              container stats · {d.usage.sampled} {d.usage.sampled === 1 ? 'copy' : 'copies'} sampled {new Date(d.usage.ts).toLocaleTimeString()} · peak {bytes(d.usage.memBytes.peak)}
            </Tech>
          ) : null}
          <PgMemoryControl stack={stack} c={c} />
        </Row>
      </dl>
    </Section>
  );
}
