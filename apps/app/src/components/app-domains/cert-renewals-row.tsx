import * as React from 'react';
import { Depth } from '@/components/calm';
import type { CertFacts } from './cert-facts-model';
import { Fact } from './cert-fact-rows';
import { renewalRows } from './cert-renewal-words';

/**
 * The renewals swarmy saw for this address (board 30): only ones it saw
 * happen (a newer certificate than the last read), so there is no row until
 * there is one.
 */
export function RenewalsRow({ facts }: { facts: CertFacts | null }): React.JSX.Element | null {
  const rows = renewalRows(facts);
  if (rows.length === 0) return null;
  return (
    <Fact k="Renewals">
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.tech}>
            <span>{r.when}</span> <span className="font-sans text-[12.5px]">{r.what}</span>
            <Depth at="controls">
              <span className="text-muted-foreground block text-[11px]">{r.tech}</span>
            </Depth>
          </li>
        ))}
      </ul>
    </Fact>
  );
}
