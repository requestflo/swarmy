import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { PendingInvitations } from '@/components/settings/pending-invitations';
import { relTime } from '@/lib/format';
import { appsLabel, presetLabel } from '@/components/apikeys/key-words';
import { MembersTab } from './members-tab';

const ROLE_SAY: Record<string, string> = {
  owner: 'Can do anything, including billing and deleting the workspace',
  admin: 'Servers, people and guardrails',
  member: 'Deploys and runs apps; production needs a rule',
};

/** Who's in: people (and robots) with what their role lets them do; attributes and grants from Controls. */
export function PeopleSection({ canInvite }: { canInvite: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  if (members.isLoading) return <CardSkeleton lines={3} />;
  const rows = members.data ?? [];
  const robots = (keys.data ?? []).filter((k) => k.status === 'active');
  return (
    <>
      <Section id="people" title="People" count={rows.length} flush>
        <RowList label="People">
          {rows.map((m) => (
            <CalmRow
              key={m.id}
              tone="ok"
              name={m.user.name}
              sub={m.user.email ?? (m.user.username ? `@${m.user.username}` : 'no email')}
              say={ROLE_SAY[m.role] ?? m.role}
              tech={`member ${m.id} · joined ${relTime(m.joinedAt)}`}
              word={m.role}
              wordTone="info"
            />
          ))}
          {robots.map((k) => (
            <CalmRow key={k.id} tone="idle" name={k.name} sub={`API key · ${k.prefix}…`} say={`${presetLabel(k)} on ${appsLabel(k.stackNames)}`} tech={`scopes ${k.scopes.join(',')} · last used ${relTime(k.lastUsedAt)}`} word="robot" wordTone="idle" to="/settings/api-keys" />
          ))}
        </RowList>
        {canInvite ? <PendingInvitations /> : null}
      </Section>
      <Depth at="controls">
        <MembersTab />
      </Depth>
    </>
  );
}
