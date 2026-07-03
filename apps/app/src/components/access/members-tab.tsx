import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, UsersIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { GrantEntry, MemberEntry } from './access-shared';
import { GrantCreateCard } from './grant-create-card';
import { GrantRow } from './grant-row';
import { MemberRow } from './member-row';

/** Members tab: ABAC attribute bags + ReBAC resource grants — all inline, no modals. */
export function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.members.list.queryOptions());
  const grants = useQuery(trpc.members.listGrants.queryOptions());
  const [editingMember, setEditingMember] = React.useState<string | null>(null);
  const [grantOpen, setGrantOpen] = React.useState(false);

  const memberRows = (members.data ?? []) as MemberEntry[];
  const grantRows = (grants.data ?? []) as GrantEntry[];

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Member attributes</CardTitle>
          <CardDescription>
            Attributes feed ABAC policies (e.g. <code>team</code>, <code>onCall</code>). Edit the
            JSON bag per member.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {memberRows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<UsersIcon />}
                title="No members yet"
                description="Invite teammates from your org settings, then tag them with attributes here."
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
                <span className="mono-label">Member</span>
                <span className="mono-label hidden sm:block">Role</span>
                <span className="mono-label hidden sm:block">Attributes</span>
                <span className="mono-label text-right">Edit</span>
              </div>
              <div className="divide-border divide-y border-t">
                {memberRows.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    expanded={editingMember === m.id}
                    onToggle={() => setEditingMember((cur) => (cur === m.id ? null : m.id))}
                  />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">Resource grants (ReBAC)</CardTitle>
            <CardDescription>
              Grant a member or team an owner/operator/viewer relation on a specific resource.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setGrantOpen((o) => !o)}>
            <PlusIcon className="size-4" /> New grant
          </Button>
        </CardHeader>
        <GrantCreateCard open={grantOpen} onOpenChange={setGrantOpen} />
        <CardContent className="p-0">
          {grantRows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<UsersIcon />}
                title="No grants yet"
                description="Access falls back to roles + policies. Add a grant to give someone a relation on one resource."
                action={
                  <Button variant="outline" onClick={() => setGrantOpen(true)}>
                    <PlusIcon className="size-4" /> New grant
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
                <span className="mono-label">Principal</span>
                <span className="mono-label hidden sm:block">Relation</span>
                <span className="mono-label hidden sm:block">Resource</span>
                <span className="mono-label text-right">Remove</span>
              </div>
              <div className="divide-border divide-y border-t">
                {grantRows.map((g) => (
                  <GrantRow key={g.id} grant={g} />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
