import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { CertIssuance } from './edge-certs-model';

/**
 * Certificates issued per day over the last 30 days (board 31's issuance
 * count, at Controls): one bar a day, the day's count on hover.
 */
export function IssuanceBars({ issuance }: { issuance: CertIssuance }): React.JSX.Element {
  const max = Math.max(1, ...issuance.days.map((d) => d.issued));
  const busiest = issuance.days.reduce((a, d) => (d.issued > a.issued ? d : a), issuance.days[0] ?? { day: '', issued: 0 });
  const label = `Certificates issued per day over ${issuance.days.length} days: ${issuance.inWindow} in all${busiest.issued ? `, the most ${busiest.issued} on ${busiest.day}` : ''}`;
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={label} className="flex h-8 items-end gap-px">
        {issuance.days.map((d) => (
          <span
            key={d.day}
            title={`${d.day} · ${d.issued} issued`}
            className={cn('min-w-0 flex-1 rounded-t-[2px]', d.issued > 0 ? 'bg-foreground/45' : 'bg-border')}
            style={{ height: d.issued > 0 ? `${Math.max(18, (d.issued / max) * 100)}%` : '2px' }}
          />
        ))}
      </div>
      <span className="text-muted-foreground flex justify-between font-mono text-[10.5px]">
        <span>{issuance.days[0]?.day}</span>
        <span>today</span>
      </span>
      <Tech>
        {`ingress.certIssuance · notBefore of each .crt in the edges' Caddy storage, counted once by fingerprint · ${issuance.reported} of ${issuance.edges} edges read · ${issuance.local} from the edge's own authority`}
      </Tech>
    </div>
  );
}
