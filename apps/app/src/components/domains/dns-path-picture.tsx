import * as React from 'react';
import { ArrowRightIcon } from 'lucide-react';
import type { DomainPlan } from '@/components/ingress/domain-state';

/** Visitor → DNS → the edges → the service: where a request goes once the records exist. */
export function DnsPathPicture({
  host,
  dnsLabel,
  dnsSub,
  plan,
  service,
}: {
  host: string;
  dnsLabel: string;
  dnsSub: string;
  plan: DomainPlan | null;
  service: string | null;
}): React.JSX.Element {
  const edges = plan?.edges ?? [];
  return (
    <figure aria-label="Where a visitor’s request goes" className="calm-card flex flex-col items-stretch gap-2 px-4 py-4 sm:flex-row sm:items-center sm:gap-3">
      <Box title="Visitor" sub={host || 'your domain'} />
      <Arrow />
      <Box title={dnsLabel} sub={dnsSub} />
      <Arrow />
      <div className="flex min-w-0 flex-col gap-2 sm:flex-[1.2]">
        {edges.length === 0 ? <Box title="Your edges" sub="no public address yet" /> : null}
        {edges.map((e) => (
          <Box key={e.ip} dot title={e.name ?? 'edge'} sub={e.ip} extra={e.region} />
        ))}
      </div>
      <Arrow />
      <Box title={service ?? 'your app'} sub="your app" />
    </figure>
  );
}

function Box({ title, sub, extra, dot }: { title: string; sub: string; extra?: string | null; dot?: boolean }): React.JSX.Element {
  return (
    <div className="border-border bg-background flex min-w-0 flex-col rounded-[10px] border px-3 py-2 sm:flex-1">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold">
        {dot ? <span aria-hidden className="bg-status-online size-2 shrink-0 rounded-full" /> : null}
        <span className="break-words">{title}</span>
      </span>
      <span className="text-muted-foreground font-mono text-[11px] break-words">{sub}</span>
      {extra ? <span className="text-muted-foreground font-mono text-[11px]">{extra}</span> : null}
    </div>
  );
}

function Arrow(): React.JSX.Element {
  return <ArrowRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0 rotate-90 self-center sm:rotate-0" />;
}
