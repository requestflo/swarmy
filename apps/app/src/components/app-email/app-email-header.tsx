import * as React from 'react';
import { Say, SayHeader } from '@/components/calm';
import type { EmailDomainData } from '@/components/email/use-email';
import { statsLine, type MailStats } from './mail-stats';
import type { EmailCredentialData } from './use-app-mail';

interface Props {
  stack: string;
  creds: EmailCredentialData[];
  stats: MailStats;
  domain: EmailDomainData | undefined;
  memoryOnly: boolean;
}

/** "storefront sends mail as app-storefront. 1,284 sent today · 99.1% delivered." */
export function AppEmailHeader({ stack, creds, stats, domain, memoryOnly }: Props): React.JSX.Element {
  const off = creds.length > 0 && creds.every((c) => c.disabled);
  const low = stats.deliveredPct !== null && stats.deliveredPct < 95;
  const title = off ? (
    <>
      {stack} has a mail login, <Say tone="warn">but it is turned off.</Say>
    </>
  ) : (
    <>
      {stack} sends mail as {creds.map((c) => c.name).join(' and ')}.{' '}
      {low ? <Say tone="warn">{statsLine(stats)}.</Say> : <em>{statsLine(stats)}.</em>}
    </>
  );
  const how = !domain ? 'No sending domain is verified yet.' : domain.delivery === 'relay' ? `From ${domain.domain}, through your relay.` : `From ${domain.domain}, straight to each inbox.`;
  const lede = `${how} Over SMTP or the HTTP API, through the mail server on your own servers.${memoryOnly ? ' The log keeps only recent events while Observability is off.' : ''}`;
  return <SayHeader size="md" title={title} lede={lede} />;
}
