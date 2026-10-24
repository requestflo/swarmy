import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, Depth, RowList, Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { SayParts } from '@/components/apikeys/say-parts';
import { absTime, relTime } from '@/lib/format';
import { appsLabel, presetLabel } from '@/components/apikeys/key-words';
import { MembersTab } from './members-tab';
import { lastSeenWords, memberScopeWords } from './people-words';

const ROLE_SAY: Record<string, string> = {
  owner: 'Can do anything, including adding owners',
  admin: 'Servers, people and guardrails',
  member: 'Deploys and runs apps; production needs a rule',
};

/** Who's in: people (and robots) with what their role lets them do and when they were last seen. */
export function PeopleSection(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  const grants = useQuery(trpc.members.listGrants.queryOptions());
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  if (members.isLoading) return <CardSkeleton lines={3} />;
  const rows = members.data ?? [];
  const robots = (keys.data ?? []).filter((k) => k.status === 'active');
  const names = new Map((stacks.data ?? []).map((s) => [s.id, s.name]));
  const stackName = (id: string): string => names.get(id) ?? id;
  return (
    <>
      <Section id="people" title="People" count={rows.length} hint="roles are a starting point, grants add to them" flush>
        <RowList label="People">
          {rows.map((m) => (
            <CalmRow
              key={m.id}
              tone={m.lastSeenAt ? 'ok' : 'idle'}
              name={m.user.name}
              sub={m.user.email ?? (m.user.username ? `@${m.user.username}` : 'no email')}
              say={<SayParts parts={[ROLE_SAY[m.role] ?? m.role, m.role === 'member' && memberScopeWords(m, grants.data ?? [], stackName), lastSeenWords(m.lastSeenAt)]} />}
              tech={`member ${m.id} · joined ${relTime(m.joinedAt)}${m.lastSeenAt ? ` · session ${absTime(m.lastSeenAt)}` : ''}`}
              word={m.role}
              wordTone="info"
            />
          ))}
          {robots.map((k) => (
            <CalmRow key={k.id} tone="idle" name={k.name} sub={`API key · ${k.prefix}…`} say={`${presetLabel(k)} on ${appsLabel(k.stackNames)}`} tech={`scopes ${k.scopes.join(',')} · last used ${relTime(k.lastUsedAt)}`} word="robot" wordTone="idle" to="/settings/api-keys" />
          ))}
        </RowList>
      </Section>
      <Depth at="controls">
        <MembersTab />
      </Depth>
    </>
  );
}
