import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IncidentDetailView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, CodeView, RowList, Section } from '@/components/calm';
import { stackFromIncidentTitle, useServiceStackMap } from '@/components/alerts/use-service-stack-map';

/** The aside: the incident as data (Code), and where it hit — its app and what is still firing. */
export function IncidentAside({ incident }: { incident: IncidentDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const stackMap = useServiceStackMap();
  const app = stackFromIncidentTitle(incident.title, stackMap);
  const firing = useQuery(trpc.alerts.events.queryOptions({ status: 'firing', limit: 20 }));
  const related = (firing.data ?? []).filter((e) => (app ? e.resource.includes(app) || e.message.includes(app) : false));
  return (
    <>
      <CodeView title="This incident as data" tabs={[{ label: 'JSON', code: JSON.stringify(incident, null, 2) }]} source="readonly" />
      <Section title="Where it hit" flush>
        <RowList label="Affected">
          {app ? <CalmRow tone={incident.status === 'open' ? 'warn' : 'ok'} name={app} sub="app" say="Open the app" to="/stacks/$name" params={{ name: app }} /> : null}
          {related.map((e) => (
            <CalmRow key={e.id} tone="warn" name={e.ruleName ?? e.signal} sub={e.resource} word="Firing" to="/alerts" />
          ))}
          {!app && related.length === 0 ? <p className="text-muted-foreground py-3 text-sm">Nothing else is tied to it right now.</p> : null}
        </RowList>
      </Section>
    </>
  );
}
