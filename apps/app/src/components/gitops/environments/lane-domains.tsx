import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import { addressCount, type LaneDomain } from './lane-domains-model';

/**
 * A lane's addresses (board Environments): every domain routed to that
 * environment's services, each with its plain status word, and Add a domain —
 * the usual add-a-domain flow with this environment's stack preselected, so
 * the new route lands on its own services' labels and nowhere else.
 */
export function LaneDomains({ stack, domains }: { stack: string; domains: LaneDomain[] | undefined }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" aria-label={`Addresses of ${stack}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-[12.5px]">{domains ? addressCount(domains.length) : 'Addresses'}</span>
        <Button asChild variant="ghost" size="sm" className="ml-auto pointer-coarse:min-h-11">
          <Link to="/network/domains/new" search={{ app: stack }}>
            <PlusIcon className="size-3.5" /> Add a domain
          </Link>
        </Button>
      </div>
      {domains === undefined ? (
        <div aria-hidden className="shimmer-line h-5 rounded-md" />
      ) : domains.length ? (
        <ul className="flex flex-col gap-1">
          {domains.map((d) => (
            <li key={`${d.host}${d.path}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <a
                href={`https://${d.host}${d.path}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-mono text-[12px] hover:underline"
                title={`${d.host}${d.path}`}
              >
                {d.host}
                {d.path}
              </a>
              <StatusWord tone={d.tone} word={d.word} className="text-[11.5px]" />
              <Tech className="w-full">{`→ ${d.service}:${d.port}${d.auto ? ' · automatic address' : ''}`}</Tech>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
