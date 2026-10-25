import * as React from 'react';
import { coversLine, servedBy, type CertFacts } from './cert-facts-model';

interface Props {
  host: string;
  facts: CertFacts | null;
  /** The TLS probe's edges, for when the edges' storage can't say. */
  probed: ReadonlyArray<{ ip: string; ok: boolean }>;
  nameOf: (ip: string) => string;
  stored: string | null;
  /** Rows the later sections add (CAA, renewals). */
  children?: React.ReactNode;
}

/** The Certificate card's facts (board 30): Covers · Served by · Stored in. */
export function CertFactRows({ host, facts, probed, nameOf, stored, children }: Props): React.JSX.Element {
  const covers = facts?.cert ? coversLine(facts.cert, host) : null;
  const edges = servedBy(facts, probed, nameOf);
  return (
    <dl className="flex flex-col text-[13px]">
      {covers ? (
        <Fact k="Covers">
          {covers.names}
          {covers.note ? <span className="text-muted-foreground block font-sans text-[12px]">{covers.note}</span> : null}
        </Fact>
      ) : null}
      <Fact k="Served by">
        {edges.length ? edges.map((e, i) => (
          <span key={e.key} className={e.ok ? '' : 'text-tone-warn'}>{i ? ' · ' : ''}{e.name}{e.note ? ` (${e.note})` : ''}</span>
        )) : <span className="text-muted-foreground">{facts?.reason ?? 'not probed yet'}</span>}
      </Fact>
      {stored ? <Fact k="Stored in">{stored}</Fact> : null}
      {children}
    </dl>
  );
}

export function Fact({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border flex min-h-9 items-center gap-3 border-b py-1.5 last:border-b-0">
      <dt className="text-muted-foreground w-24 shrink-0 text-[12.5px] font-semibold">{k}</dt>
      <dd className="min-w-0 font-mono text-[12px] break-words">{children}</dd>
    </div>
  );
}
