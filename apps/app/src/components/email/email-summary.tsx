import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, NextAction, RowList, Section } from '@/components/calm';
import { useEmailMutationHandlers, type EmailDomainData, type EmailOverviewData } from './use-email';

const missing = (d: EmailDomainData): number => d.records.filter((r) => r.status !== 'ok').length;

/** The one next action: the first domain still waiting for its records. */
export function EmailNextAction({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element | null {
  const trpc = useTRPC();
  const check = useMutation(trpc.email.checkDomain.mutationOptions(useEmailMutationHandlers()));
  const d = o.domains.find((x) => !x.verifiedAt);
  if (!d) return null;
  const n = missing(d);
  return (
    <NextAction
      title={`Add ${n} record${n === 1 ? '' : 's'} for ${d.domain}, then it can send`}
      tech={d.records.filter((r) => r.status !== 'ok').map((r) => `${r.type} ${r.name}`).join(' · ')}
      actions={
        <Button disabled={check.isPending} onClick={() => check.mutate({ id: d.id })}>
          {check.isPending ? 'Checking…' : 'I’ve added them, check'}
        </Button>
      }
    >
      The records are below at Controls, ready to copy. swarmy also checks by itself every few minutes.
    </NextAction>
  );
}

/** Sending domains as flat rows: ready or waiting, and how mail leaves. */
export function EmailDomainRows({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  return (
    <Section title="Sending domains" count={o.domains.length} flush>
      <RowList label="Sending domains">
        {o.domains.map((d) => {
          const ok = !!d.verifiedAt;
          const n = missing(d);
          return (
            <CalmRow
              key={d.id}
              tone={ok ? 'ok' : 'warn'}
              name={<span className="font-mono text-[13.5px]">{d.domain}</span>}
              sub={d.dns.mode === 'swarmy' ? 'records published by swarmy' : 'records at your DNS provider'}
              say={ok ? `Signed and sending, ${d.delivery === 'relay' ? 'through your relay' : 'straight to each inbox'}` : `Waiting for ${n} record${n === 1 ? '' : 's'}`}
              tech={`dkim selector ${d.selector} · dmarc p=${d.dmarcPolicy} · ${d.delivery}`}
              word={ok ? 'Online' : 'Needs you'}
            />
          );
        })}
      </RowList>
    </Section>
  );
}

const EVENT: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'info'; word: string }> = {
  delivered: { tone: 'ok', word: 'Delivered' },
  queued: { tone: 'info', word: 'Queued' },
  deferred: { tone: 'warn', word: 'Retrying' },
  bounced: { tone: 'bad', word: 'Bounced' },
  complained: { tone: 'bad', word: 'Complaint' },
};

/** The last few messages, recipient masked the way the log shows it. */
export function RecentMail(): React.JSX.Element {
  const trpc = useTRPC();
  const log = useQuery({ ...trpc.email.log.queryOptions({ limit: 6 }), refetchInterval: 15_000 });
  const items = (log.data?.items ?? []).slice(0, 6) as Array<{ ts: string; event: string; rcpt: string; subject: string; messageId: string }>;
  return (
    <Section title="Sent mail" hint="latest" flush>
      {items.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">{log.isPending ? 'Loading…' : 'Nothing sent yet.'}</p>
      ) : (
        <RowList label="Recent mail">
          {items.map((m, i) => {
            const e = EVENT[m.event] ?? { tone: 'info' as const, word: m.event };
            return (
              <CalmRow
                key={`${m.messageId}-${m.event}-${i}`}
                tone={e.tone}
                name={m.subject || '(no subject)'}
                sub={`${m.rcpt.replace(/^(.).*@/, '$1•••@')} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                word={e.word}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
