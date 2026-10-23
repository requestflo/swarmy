import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Section, SectionLink, Tech, useDepth } from '@/components/calm';
import type { EmailDomainData, EmailOverviewData } from '@/components/email/use-email';
import { RelayFacts } from './relay-facts';

interface Props {
  stack: string;
  overview: EmailOverviewData;
  /** The domains this app may send from (its credentials' list, else every verified one). */
  domains: EmailDomainData[];
}

/**
 * How mail leaves (Email board): the app → swarmy's mail server (signs with
 * the domain's DKIM key) → the relay or straight out on port 25 → the
 * recipient, for the app's main sending domain; then that domain's relay
 * facts, or the last port-25 check. Changing delivery lives on Email.
 */
export function MailFlow({ stack, overview: o, domains }: Props): React.JSX.Element {
  const tech = useDepth().atLeast('controls');
  const d = domains[0];
  const relay = d?.delivery === 'relay' ? d.relay : null;
  const mta = o.mta.running ? 'running' : o.mta.deployed ? 'starting' : 'waiting for a manager';
  return (
    <Section title="How mail leaves" hint={d ? `from ${d.domain}` : undefined} action={<Link to="/email"><SectionLink>Change on Email →</SectionLink></Link>}>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="The path one message takes">
        <Stop title={stack} sub={tech ? 'SMTP or HTTP API' : 'sends a message'} />
        <Dashes />
        <Stop title="swarmy mail" sub={tech ? `${o.mta.host}:${o.mta.port} · ${mta}` : `signs it · ${mta}`} accent />
        <Dashes />
        {relay ? (
          <Stop title="Your relay" sub={`${relay.host}:${relay.port}`} />
        ) : (
          <Stop title="Straight out" sub={tech ? `port 25 · ${o.mta.nodeIps[0] ?? 'mail node IP not known yet'}` : 'to each inbox'} />
        )}
        <Dashes />
        <Stop title="Recipient" sub="their inbox" />
      </ol>
      {d ? <RelayFacts overview={o} domain={d} /> : <p className="text-muted-foreground text-[13px]">No sending domain is verified yet, so nothing can leave.</p>}
      {domains.length > 1 ? (
        <Tech>
          also sends from {domains.slice(1).map((x) => `${x.domain} (${x.delivery === 'relay' ? `relay ${x.relay?.host ?? ''}` : 'direct'})`).join(' · ')}
        </Tech>
      ) : null}
    </Section>
  );
}

function Dashes(): React.JSX.Element {
  return <li aria-hidden className="flow-dashes hidden sm:block" />;
}

function Stop({ title, sub, accent }: { title: string; sub: string; accent?: boolean }): React.JSX.Element {
  return (
    <li className={cn('flex min-w-0 flex-col gap-0.5 rounded-[10px] border px-3 py-1.5', accent ? 'border-primary/50' : 'border-border')}>
      <span className="truncate text-[12.5px] font-semibold">{title}</span>
      <span className="text-muted-foreground truncate font-mono text-[11px]">{sub}</span>
    </li>
  );
}
