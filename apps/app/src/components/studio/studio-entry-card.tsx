import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CalmRow, RowList, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

/** Data tab entry: every database of the app with a link into its studio. Hidden when there are none. */
export function StudioEntryCard({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const q = useQuery(trpc.studio.targets.queryOptions({ stack }));
  if (!q.data || q.data.length === 0) return null;
  return (
    <Section title="Database studio" hint="browse, edit and query · read-only by default · every query audited" flush>
      <RowList label="Databases you can open">
        {q.data.map((t) => (
          <CalmRow
            key={t.name}
            tone={t.unavailable || !t.running ? 'idle' : 'ok'}
            name={t.name}
            sub={`${t.engine}${t.kind === 'managed' ? ' · managed' : ''}`}
            say={t.unavailable ?? (t.running ? 'Open its tables, run a query.' : 'Not running.')}
            word="Open studio →"
            wordTone="info"
            onClick={() => void navigate({ to: '/stacks/$name/studio', params: { name: stack }, search: { db: t.name } })}
          />
        ))}
      </RowList>
    </Section>
  );
}
