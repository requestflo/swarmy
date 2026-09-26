import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { DomainDetail } from '@/components/ingress/domain-state';
import { STEPS, agreeCount, railState } from './lifecycle';

/** The 4-step progress rail: Waiting for DNS → Verified → Issuing certificate → Active. */
export function VerifyRail({ d }: { d: DomainDetail }): React.JSX.Element {
  const rail = railState(d);
  const resolvers = d.dns?.resolvers ?? [];
  const { seen, answered } = agreeCount(resolvers);
  const matched = resolvers.filter((r) => r.matches).map((r) => r.resolver);
  const pub = matched.filter((r) => r !== 'system' && r !== 'swarmy-dns');
  const agreed = pub.length ? pub : matched.map((r) => (r === 'system' ? 'swarmy' : r));
  const subs = [
    d.verifiedManually ? 'skipped by an admin' : answered ? `${seen} of ${answered} resolvers` : 'asking resolvers…',
    d.verifiedManually ? 'without a DNS check' : agreed.length ? `${agreed.join(' + ')} agree` : 'every resolver must agree',
    'Let’s Encrypt',
    'HTTPS everywhere',
  ];
  return (
    <ol aria-label="Progress" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:items-center sm:gap-0">
      {STEPS.map((label, i) => {
        const done = i < rail.current;
        const cur = i === rail.current;
        const bad = cur && rail.failed;
        return (
          <li key={label} aria-current={cur ? 'step' : undefined} className="flex min-w-0 items-center gap-2.5 sm:flex-1">
            <span
              aria-hidden
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full border-[1.5px] font-mono text-[12px]',
                done && 'border-status-online bg-status-online/15 text-tone-ok',
                cur && !bad && 'border-status-progress text-tone-info',
                bad && 'border-status-offline text-tone-bad',
                !done && !cur && 'border-border text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="size-4" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={cn('text-[13px]', cur ? 'font-bold' : 'font-semibold', !done && !cur && 'text-muted-foreground')}>
                {label}
                <span className="sr-only">{done ? ' (done)' : cur ? (bad ? ' (failed)' : ' (in progress)') : ''}</span>
              </span>
              <span className="text-muted-foreground truncate font-mono text-[11px]">{bad ? 'needs you' : subs[i]}</span>
            </span>
            {i < STEPS.length - 1 ? (
              <span aria-hidden className={cn('mx-3 hidden h-px min-w-6 flex-1 sm:block', done ? 'bg-status-online' : 'bg-border')} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
