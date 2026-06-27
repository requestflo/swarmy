import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { GeneralTab } from '@/components/settings/general-tab';
import { MembersTab } from '@/components/settings/members-tab';
import { TokensTab } from '@/components/settings/tokens-tab';

/** Settings sections: org general · members · join tokens. */
export function SettingsTabs(): React.JSX.Element {
  return (
    <Tabs defaultValue="tokens">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="tokens">Join tokens</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="mt-6">
        <GeneralTab />
      </TabsContent>
      <TabsContent value="members" className="mt-6">
        <MembersTab />
      </TabsContent>
      <TabsContent value="tokens" className="mt-6">
        <TokensTab />
      </TabsContent>
    </Tabs>
  );
}
