import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { MemberMfaList } from './member-mfa-list';
import { Require2faCard } from './require-2fa-card';
import { TerminalApprovalsCard } from './terminal-approvals-card';
import { TerminalPolicyCard } from './terminal-policy-card';

/** The workspace's sign-in and terminal policies (owners and admins). Your own 2FA lives in Settings → Workspace. */
export function SecurityTab(): React.JSX.Element | null {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const isAdmin = org.data?.role === 'owner' || org.data?.role === 'admin';
  if (!isAdmin) return null;
  return (
    <div id="security" className="grid gap-5 xl:grid-cols-2">
      <Require2faCard />
      <TerminalPolicyCard />
      <TerminalApprovalsCard />
      <MemberMfaList />
    </div>
  );
}
