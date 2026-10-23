import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { InvService, SecretFamilyView } from '@swarmy/core';
import { Section, SectionLink, TONE_DOT, Tech } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { aboutApp, describeEvent, VAR_AUDIT_ACTIONS } from './var-activity-model';

/**
 * Who changed this app's secrets and settings, from the audit log
 * (`audit.list`, secret events + updates that set secret variables) —
 * the names, never the values.
 */
export function VariablesActivity({
  stack,
  services,
  families,
}: {
  stack: string;
  services: InvService[] | undefined;
  families: SecretFamilyView[] | undefined;
}): React.JSX.Element {
  const trpc = useTRPC();
  const audit = useQuery({ ...trpc.audit.list.queryOptions({ actions: VAR_AUDIT_ACTIONS, limit: 100 }), refetchInterval: 15_000 });
  const scope = React.useMemo(
    () => ({
      stack,
      serviceIds: new Set((services ?? []).map((s) => s.id)),
      serviceNames: new Set((services ?? []).map((s) => s.name)),
      families: new Set((families ?? []).filter((f) => f.consumers.some((c) => c.stack === stack)).map((f) => f.family)),
    }),
    [stack, services, families],
  );
  const rows = (audit.data?.entries ?? []).filter((e) => aboutApp(e, scope)).slice(0, 6);
  return (
    <Section
      title="Recent changes"
      hint="who set, revealed or rotated what — never the value"
      flush
      action={
        <Link to="/audit" className="pointer-coarse:min-h-11 content-center">
          <SectionLink>Audit log →</SectionLink>
        </Link>
      }
    >
      {audit.isPending || !services || !families ? (
        <RowsSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">Nothing changed recently. Every set, reveal and rotate lands here.</p>
      ) : (
        <ul aria-label="Recent changes" className="flex flex-col">
          {rows.map((e) => {
            const d = describeEvent(e, stack);
            return (
              <li key={e.id} className="border-border flex min-h-10 items-center gap-3 border-b py-2 text-[13px] last:border-b-0">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${TONE_DOT[d.tone]}`} />
                <span className="min-w-0 flex-1">
                  {d.text}
                  <span className="block">
                    <Tech>{e.action}</Tech>
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{relTime(e.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
