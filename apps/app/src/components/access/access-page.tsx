import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { InviteMemberDialog } from '@/components/settings/invite-member-dialog';
import { SecurityTab } from '@/components/security/security-tab';
import { accessCode } from './access-code';
import { InviteLinksSection } from './invite-links-section';
import { PeopleSection } from './people-section';
import { PoliciesTab } from './policies-tab';
import { PolicyWhoCan } from './policy-who-can';
import { SignInSection } from './signin-section';
import type { PolicyRow } from './use-policy-editor';
import { useSignInMethods } from './use-signin-methods';

/** Settings → People & access: who's in, what the rules let them do, how they sign in. */
export function AccessPage(): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const members = useQuery(trpc.org.members.queryOptions());
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  const policies = useQuery(trpc.policies.list.queryOptions());
  const { methods } = useSignInMethods();
  const role = org.data?.role;
  const canInvite = role === 'owner' || role === 'admin';
  const inviteLinks = useQuery({ ...trpc.inviteLinks.list.queryOptions(), enabled: canInvite });
  const robots = (keys.data ?? []).filter((k) => k.status === 'active').length;
  const social = methods?.filter((m) => m.enabled && m.kind === 'social').map((m) => m.label) ?? [];
  const company = [...(methods?.some((m) => m.enabled && m.kind === 'sso') ? ['company sign-in'] : []), ...social];

  const title = !members.data || !methods ? (
    'Who gets in, and what they can do.'
  ) : (
    <>
      {plural(members.data.length, 'person', 'people')} and {plural(robots, 'robot')} can change things.{' '}
      <em>Sign-in is by {company.length ? company.slice(0, 2).join(' and ') : 'username and password'}.</em>
    </>
  );
  const rules = (policies.data ?? []) as PolicyRow[];

  return (
    <RowPage
      title={title}
      description="Roles are the starting point; rules narrow or widen that, and every decision is logged."
      actions={canInvite ? <InviteMemberDialog callerRole={role} /> : undefined}
      aside={
        <>
          <CodeView
            title="Access as code"
            tabs={accessCode(rules, methods ?? [], canInvite ? (inviteLinks.data ?? []) : null)}
            note="Dashboard setting. Each rule is a policy document that runs the same on the JSON engine or Cedar. Rules and invite links are edited here and audited; there is no REST route for them yet."
          />
          <PolicyWhoCan />
        </>
      }
    >
      <PeopleSection canInvite={canInvite} />
      {canInvite ? <InviteLinksSection /> : null}
      <PoliciesTab />
      <SignInSection methods={methods} />
      <Depth at="controls">
        <SecurityTab />
      </Depth>
    </RowPage>
  );
}
