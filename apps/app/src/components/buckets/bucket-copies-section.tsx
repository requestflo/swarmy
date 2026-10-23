import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { copiesSay, memberWord, type CopyMember } from './bucket-facts';

/** Copies: the servers that keep this bucket's files, each its own zone, and what survives losing one. */
export function BucketCopiesSection({ copies, members }: { copies: number | undefined; members: CopyMember[] | undefined }): React.JSX.Element {
  return (
    <Section title="Copies" hint={copies ? `each file on ${copies} server${copies === 1 ? '' : 's'}` : undefined}>
      {members === undefined || copies === undefined ? (
        <CardSkeleton lines={1} />
      ) : members.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No servers keep files yet. Turn storage on from Backups.</p>
      ) : (
        <>
          <ul className="grid gap-2.5 sm:grid-cols-3">
            {members.map((m) => {
              const w = memberWord(m);
              return (
                <li key={m.name} className="bg-background flex flex-col gap-0.5 rounded-xl border px-3 py-2.5">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[w.tone])} />
                    {m.name}
                  </span>
                  <span className={cn('font-mono text-[11px]', w.tone === 'ok' ? 'text-muted-foreground' : TONE_TEXT[w.tone])}>{w.word}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-[13px]">{copiesSay(copies, members)}</p>
          <Tech>
            replication factor {copies} · one zone per server · {members.length} member{members.length === 1 ? '' : 's'}
          </Tech>
        </>
      )}
    </Section>
  );
}
