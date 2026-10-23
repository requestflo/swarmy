import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CodeView, NextAction, SayHeader } from '@/components/calm';
import { ErrorState, HeaderSkeleton, PageSkeleton } from '@/components/states';
import { TabBody } from '@/components/app-tabs/tab-body';
import { appEmailCode } from './app-email-code';
import { AppEmailHeader } from './app-email-header';
import { AppMailEnv } from './app-mail-env';
import { MailFlow } from './mail-flow';
import { useAppMail } from './use-app-mail';

/**
 * Config › Email (board 66): this app's mail. The login bound to it, today's
 * sent and delivered from the send log, the path a message takes (relay or
 * straight out) and the variables its services get. Domains, relays and the
 * port-25 check are workspace-wide and stay on Email.
 */
export function AppEmailTab({ stack }: { stack: string }): React.JSX.Element {
  const { overview, creds, stats, logSource } = useAppMail(stack);
  if (overview.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  if (overview.isError) return <ErrorState error={overview.error} retry={() => void overview.refetch()} retrying={overview.isFetching} />;
  const o = overview.data;
  const verified = o.domains.filter((d) => d.verifiedAt);
  const allowed = [...new Set(creds.flatMap((c) => c.domains))];
  const domains = allowed.length ? verified.filter((d) => allowed.includes(d.domain)) : verified;
  const code = <CodeView title="Email as code" tabs={appEmailCode(stack, o, creds)} source="yaml" />;

  if (!o.enabled || creds.length === 0) {
    return (
      <TabBody
        asideAt="code"
        aside={code}
        header={
          <SayHeader
            size="md"
            title={!o.enabled ? <>{stack} can’t send mail yet. <em>Email is off for the workspace.</em></> : <>{stack} doesn’t send mail through swarmy yet.</>}
            lede="Add email: true to swarmy.yaml. The next deploy makes the app its own login and gives its services what they need to send."
          />
        }
      >
        {!o.enabled ? (
          <NextAction title="Turn on email once, for every app" actions={<Button asChild><Link to="/email">Open Email</Link></Button>}>
            The mail server runs on your own servers. Your sending domains and how mail leaves are set there.
          </NextAction>
        ) : null}
        <MailFlow stack={stack} overview={o} domains={domains} />
      </TabBody>
    );
  }

  return (
    <TabBody
      asideAt="code"
      aside={code}
      header={stats ? <AppEmailHeader stack={stack} creds={creds} stats={stats} domain={domains[0]} memoryOnly={logSource === 'memory'} /> : <HeaderSkeleton />}
    >
      <MailFlow stack={stack} overview={o} domains={domains} />
      {creds.map((c) => (
        <AppMailEnv key={c.id} stack={stack} overview={o} cred={c} />
      ))}
    </TabBody>
  );
}
