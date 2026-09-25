import * as React from 'react';
import { Say, SayHeader } from '@/components/calm';
import type { SayParts } from '@/components/apps/estate-say';
import type { EstateSummary } from '@/lib/use-estate-summary';
import { relTime } from '@/lib/format';

function today(): string {
  const d = new Date();
  const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${t}`;
}

/** The lede: the numbers behind the sentence, only ones that have settled. */
export function overviewLede(e: EstateSummary, lastChangeAt: string | null, lastBackupAt: string | null): string {
  const { services, nodes } = e;
  const parts =
    services.running === services.total
      ? `All ${services.total} parts running`
      : `${services.running} of ${services.total} parts running`;
  const where =
    nodes.online === nodes.total ? ` on ${nodes.total} server${nodes.total === 1 ? '' : 's'}.` : ` on ${nodes.online} of ${nodes.total} servers.`;
  const change = lastChangeAt ? ` Last change ${relTime(lastChangeAt)}.` : '';
  const backup = lastBackupAt ? ` Last backup ${relTime(lastBackupAt)}.` : '';
  return `${parts}${where}${change}${backup}`;
}

export function OverviewHeader({ say, lede }: { say: SayParts; lede: string }): React.JSX.Element {
  return (
    <SayHeader
      eyebrow={today()}
      title={
        <>
          {say.lead}
          {say.clause ? (
            <>
              {say.lead ? ' ' : ''}
              <Say tone={say.clause.tone}>{say.clause.text}</Say>
            </>
          ) : null}
        </>
      }
      lede={lede}
    />
  );
}
