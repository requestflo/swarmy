import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { PageError, PageSkeleton } from '@/components/states';
import { CredentialsTab } from './credentials-tab';
import { DomainsTab } from './domains-tab';
import { EmailOffCard } from './email-off-card';
import { EmailStatusStrip } from './email-status-strip';
import { EmailWarnings } from './email-warnings';
import { SendLogTab } from './send-log-tab';
import { SuppressionsTab } from './suppressions-tab';
import { TemplatesCard } from './templates-card';
import { useEmailOverview } from './use-email';

/**
 * The Email page (developer-platform §8): swarmy's own outbound mail — the
 * MTA, sending domains with their DNS records, per-app credentials,
 * templates, the send log and the suppression list. Mutations are
 * ABAC-gated server-side (`email.write` / `email.send`).
 */
export function EmailPage(): React.JSX.Element {
  const overview = useEmailOverview();
  if (overview.isPending) return <PageSkeleton variant="kpis" />;
  if (overview.isError) {
    return (
      <PageError
        title="Couldn’t load the email service."
        error={overview.error}
        retry={() => void overview.refetch()}
        retrying={overview.isFetching}
      />
    );
  }
  const o = overview.data;
  const verified = o.domains.filter((d) => d.verifiedAt).length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Platform"
        title={
          !o.enabled ? (
            <>
              Send mail from <em>your</em> domains.
            </>
          ) : verified === 0 ? (
            <>
              Add a domain to <em>start</em> sending.
            </>
          ) : (
            <>
              {verified} domain{verified === 1 ? '' : 's'} ready to <em>send</em>.
            </>
          )
        }
        description="An in-cluster mail server with an HTTP send API: DKIM-signed mail from your domains, per-app SMTP logins and API keys, templates, bounce handling and a send log. swarmy's own invites, sign-up checks and alerts use it too."
      />

      {!o.enabled ? (
        <EmailOffCard vaultReady={o.vaultReady} />
      ) : (
        <>
          <EmailStatusStrip overview={o} />
          <EmailWarnings warnings={o.warnings} />
          <Tabs defaultValue="domains" className="mt-6">
            <TabsList>
              <TabsTrigger value="domains">Domains</TabsTrigger>
              <TabsTrigger value="log">Send log</TabsTrigger>
              <TabsTrigger value="suppressions">Suppressions</TabsTrigger>
              <TabsTrigger value="credentials">Credentials & templates</TabsTrigger>
            </TabsList>
            <TabsContent value="domains" className="mt-4">
              <DomainsTab overview={o} />
            </TabsContent>
            <TabsContent value="log" className="mt-4">
              <SendLogTab logStore={o.logStore} />
            </TabsContent>
            <TabsContent value="suppressions" className="mt-4">
              <SuppressionsTab />
            </TabsContent>
            <TabsContent value="credentials" className="mt-4 space-y-4">
              <CredentialsTab overview={o} />
              <TemplatesCard />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
