import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { UsersIcon } from 'lucide-react';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { ProvidersTab } from '@/components/access/providers-tab';
import { SsoTab } from '@/components/access/sso-tab';
import { MembersTab } from '@/components/access/members-tab';
import { PoliciesTab } from '@/components/access/policies-tab';

export const Route = createFileRoute('/_authed/settings_/access')({
  component: AccessPage,
});

function AccessPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Governance"
        title={
          <>
            Who gets <em>in</em>, and what they can do.
          </>
        }
        description="Flip on sign-in providers, wire enterprise SSO, and shape access with policies — live, no restart."
        actions={
          <Button asChild>
            <Link to="/settings">
              <UsersIcon className="size-4" /> Manage members
            </Link>
          </Button>
        }
      />
      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Sign-in</TabsTrigger>
          <TabsTrigger value="sso">Enterprise SSO</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="mt-6">
          <ProvidersTab />
        </TabsContent>
        <TabsContent value="sso" className="mt-6">
          <SsoTab />
        </TabsContent>
        <TabsContent value="members" className="mt-6">
          <MembersTab />
        </TabsContent>
        <TabsContent value="policies" className="mt-6">
          <PoliciesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
