import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, Say, Section } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { CredentialsTab } from './credentials-tab';
import { DomainsTab } from './domains-tab';
import { EmailOffCard } from './email-off-card';
import { EmailStatusStrip } from './email-status-strip';
import { EmailWarnings } from './email-warnings';
import { SendLogTab } from './send-log-tab';
import { SuppressionsTab } from './suppressions-tab';
import { TemplatesCard } from './templates-card';
import { EmailDomainRows, EmailNextAction, RecentMail } from './email-summary';
import { EmailCode } from './email-code';
import { useEmailOverview } from './use-email';

/**
 * The Email page: swarmy's own outbound mail. Summary says which domains can
 * send and the one thing to do; Controls holds the records, delivery,
 * credentials, templates, log and suppressions; Code the app's `email:` key.
 * Mutations are ABAC-gated server-side (`email.write` / `email.send`).
 */
export function EmailPage(): React.JSX.Element {
  const overview = useEmailOverview();
  if (overview.isPending) return <PageSkeleton variant="list" />;
  if (overview.isError) {
    return <PageError title="Couldn’t load the email service." error={overview.error} retry={() => void overview.refetch()} retrying={overview.isFetching} />;
  }
  const o = overview.data;
  const verified = o.domains.filter((d) => d.verifiedAt).length;
  const waiting = o.domains.length - verified;
  const direct = o.port25?.verdict === 'open';
  const title = !o.enabled ? (
    <>Send mail from your own domains. <em>Email is off.</em></>
  ) : verified === 0 ? (
    <>No domain can send yet. <em>Add one to start.</em></>
  ) : (
    <>
      {verified} domain{verified === 1 ? '' : 's'} sending mail.{' '}
      {waiting ? <Say tone="warn">{waiting} waiting for records.</Say> : <em>Signed, bounces handled.</em>}
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        title={title}
        description="Apps send over SMTP or an HTTP API, from your domains, through a mail server on your own servers. swarmy's invites and alerts use it too."
      />
      {!o.enabled ? (
        <EmailOffCard vaultReady={o.vaultReady} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-5">
            <EmailNextAction overview={o} />
            <EmailDomainRows overview={o} />
            <Section title="How mail leaves">
              <p className="text-muted-foreground text-[13.5px] leading-relaxed">
                {direct
                  ? 'Straight to each inbox from your mail server. Start with low volumes: a new server has no sending reputation yet.'
                  : 'Direct delivery looks blocked by your cloud. Send through a relay you trust (set it per domain at Controls).'}
              </p>
            </Section>
            <Depth at="controls">
              <EmailStatusStrip overview={o} />
              <EmailWarnings warnings={o.warnings} />
              <Tabs defaultValue="domains">
                <TabsList>
                  <TabsTrigger value="domains">Records</TabsTrigger>
                  <TabsTrigger value="log">Send log</TabsTrigger>
                  <TabsTrigger value="suppressions">Never mailed again</TabsTrigger>
                  <TabsTrigger value="credentials">Logins & templates</TabsTrigger>
                </TabsList>
                <TabsContent value="domains" className="mt-4"><DomainsTab overview={o} /></TabsContent>
                <TabsContent value="log" className="mt-4"><SendLogTab logStore={o.logStore} /></TabsContent>
                <TabsContent value="suppressions" className="mt-4"><SuppressionsTab /></TabsContent>
                <TabsContent value="credentials" className="mt-4 space-y-4">
                  <CredentialsTab overview={o} />
                  <TemplatesCard />
                </TabsContent>
              </Tabs>
            </Depth>
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            <EmailCode overview={o} />
            <RecentMail />
            <AlreadyOn
              items={[
                { what: 'Signed', detail: 'every message carries your domain’s DKIM signature' },
                { what: 'Bounces', detail: 'addresses that bounce are never mailed again' },
                { what: 'Logins', detail: `one per app (${o.credentials.filter((c) => !c.system).length} so far), made on first deploy` },
              ]}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
