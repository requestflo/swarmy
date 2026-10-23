import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink, Tech } from '@/components/calm';
import { envVarsFor, hostPort, KIND_WORD, listWords, shortOf, type ManagedGroup } from './connections-model';
import { AttachDbLine } from './attach-db-line';
import type { StackEndpoints } from './types';

/**
 * "Managed data · private to storefront": each database, cache and bucket,
 * the address to reach it at, and who already has it wired (and in which env
 * var). Only attached services share its network; a connected app never does.
 */
export function ManagedDataSection({
  endpoints: e,
  groups,
  vars,
}: {
  endpoints: StackEndpoints;
  groups: ManagedGroup[];
  vars: Record<string, string[]>;
}): React.JSX.Element {
  return (
    <Section
      title="Managed data"
      hint={`private to ${e.stack}`}
      flush
      action={
        <Link to="/stacks/$name/data" params={{ name: e.stack }}>
          <SectionLink>Data tab →</SectionLink>
        </Link>
      }
    >
      {groups.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">{e.stack} has no managed database, cache or bucket.</p>
      ) : (
        <div className="flex flex-col">
          {groups.map((g) => (
            <ManagedRow key={`${g.kind}:${g.name}`} e={e} g={g} vars={envVarsFor(g, vars)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function ManagedRow({ e, g, vars }: { e: StackEndpoints; g: ManagedGroup; vars: string[] }): React.JSX.Element {
  const who = g.attached.map((s) => shortOf(e.stack, s));
  const unattached = g.kind === 'postgres' ? e.services.filter((s) => !g.attached.includes(s.service)).map((s) => s.short) : [];
  return (
    <div className="border-border flex flex-col gap-1 border-b py-2.5 last:border-b-0">
      <span className="text-[13.5px]">
        Reach {KIND_WORD[g.kind]} <b className="font-semibold">{g.name}</b> at{' '}
        <span className="font-mono break-all">{hostPort(g.main.host, g.main.port)}</span>
      </span>
      <span className="text-muted-foreground text-[12px]">
        {who.length ? (
          <>
            from {listWords(who)}
            {vars.length ? (
              <>
                {' '}— already in <span className="font-mono">{listWords(vars)}</span>
              </>
            ) : null}
          </>
        ) : (
          `Nothing in ${e.stack} is attached to it yet.`
        )}
      </span>
      {g.others.length ? (
        <Tech>
          {g.others
            .map((o) => `${o.role ?? 'member'} ${hostPort(o.host, o.port)}${g.kind === 'postgres' && o.role === 'replica' ? ' (read-only, DATABASE_RO_URL)' : ''}`)
            .join(' · ')}
        </Tech>
      ) : null}
      {unattached.length ? <AttachDbLine stack={e.stack} cluster={g.name} services={unattached} /> : null}
    </div>
  );
}
