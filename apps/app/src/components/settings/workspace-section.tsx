import * as React from 'react';
import { CalmRow, RowList, Section } from '@/components/calm';

/** The workspace itself: name, address slug, your role. */
export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

export function WorkspaceSection({ org, people, servers }: { org: OrgInfo; people?: number; servers?: number }): React.JSX.Element {
  return (
    <Section id="workspace" title="Workspace" flush>
      <RowList label="Workspace">
        <CalmRow tone="ok" name="Name" say={org.name} tech={`org ${org.id}`} />
        <CalmRow tone="idle" name="Short name" say={org.slug} tech="used in URLs and the CLI" />
        <CalmRow tone="idle" name="Your role" say={org.role === 'owner' ? 'Owner: can do anything, including billing and deleting the workspace' : org.role === 'admin' ? 'Admin: servers, people and guardrails' : 'Member: what your roles and rules allow'} word={org.role} wordTone="info" />
        {people !== undefined && servers !== undefined ? (
          <CalmRow tone="idle" name="In it" say={`${people} ${people === 1 ? 'person' : 'people'} · ${servers} ${servers === 1 ? 'server' : 'servers'}`} to="/settings/access" />
        ) : null}
      </RowList>
    </Section>
  );
}
