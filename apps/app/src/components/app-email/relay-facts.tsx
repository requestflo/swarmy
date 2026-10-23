import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech, TONE_TEXT } from '@/components/calm';
import type { EmailDomainData, EmailOverviewData } from '@/components/email/use-email';

/**
 * The facts behind "how mail leaves" for one sending domain, read-only: the
 * relay's host, port, security, user and whether its secret is set
 * (write-only, never shown); or, for direct delivery, the last port-25 check
 * and the reputation notes the email service raised.
 */
export function RelayFacts({ overview: o, domain: d }: { overview: EmailOverviewData; domain: EmailDomainData }): React.JSX.Element {
  if (d.delivery === 'relay' && d.relay) {
    const r = d.relay;
    const facts: Array<[string, string]> = [
      ['Relay host', r.host],
      ['Port', String(r.port)],
      ['Security', r.security],
      ['User', r.username ?? 'none'],
      ['Secret', r.passwordSet ? '••• set · write-only' : 'not set'],
    ];
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[13px]">Mail from {d.domain} goes through a relay you trust, so its reputation does the work.</p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-1.5">
              <dt className="text-muted-foreground text-[11px]">{k}</dt>
              <dd className="truncate font-mono text-[12px]">{v}</dd>
            </div>
          ))}
        </dl>
        {r.spfInclude ? <Tech>SPF include:{r.spfInclude}</Tech> : null}
      </div>
    );
  }
  const p = o.port25;
  const tone = !p ? 'idle' : p.verdict === 'open' ? 'ok' : p.verdict === 'blocked' ? 'bad' : 'warn';
  const notes = o.warnings.filter((w) => w.id === 'fresh-ip' || w.id === 'port25');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px]">
        <span className={cn('font-semibold', TONE_TEXT[tone])}>{p ? 'Last port-25 check:' : 'Port 25 not checked yet.'}</span>{' '}
        <span className="text-muted-foreground">{p ? p.message : 'Check it on Email before sending important mail.'}</span>
      </p>
      {notes
        .filter((w) => w.id !== 'port25' || !p)
        .map((w) => (
          <p key={w.id} className="text-muted-foreground text-[13px] leading-relaxed">
            {w.message}
          </p>
        ))}
      <Tech>
        HELO {o.mta.helo} · sends from {o.mta.nodeIps.join(', ') || 'the mail node'}
        {p ? ` · checked ${new Date(p.at).toLocaleString()}` : ''}
      </Tech>
    </div>
  );
}
