import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BookOpenIcon } from 'lucide-react';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';
import { ApiKeysTab } from '@/components/apikeys/api-keys-tab';
import { OauthClientsTab } from '@/components/apikeys/oauth-clients-tab';

export const Route = createFileRoute('/_authed/settings/api-keys')({
  component: ApiKeysPage,
});

function ApiKeysPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="API keys"
        title={
          <>
            Make swarmy <em>programmable</em>.
          </>
        }
        description="Mint org-scoped credentials for the public REST API, the SDKs, or the Terraform provider — static keys or rotating OAuth tokens."
        actions={
          <Button variant="outline" asChild>
            <a href="/api/v1/docs" target="_blank" rel="noreferrer">
              <BookOpenIcon className="size-4" /> API reference
            </a>
          </Button>
        }
      />

      <Tabs defaultValue="keys">
        <TabsList>
          <TabsTrigger value="keys">API keys</TabsTrigger>
          <TabsTrigger value="oauth">OAuth clients</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-6">
          <ApiKeysTab />
        </TabsContent>
        <TabsContent value="oauth" className="mt-6">
          <OauthClientsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
