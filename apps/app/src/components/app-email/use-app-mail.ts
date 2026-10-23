import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { useEmailOverview, type EmailOverviewData } from '@/components/email/use-email';
import { LOG_LIMIT, mailStats, type MailStats } from './mail-stats';

export type EmailCredentialData = EmailOverviewData['credentials'][number];

export interface AppMail {
  overview: ReturnType<typeof useEmailOverview>;
  /** Credentials bound to this app (`stack` on the credential row). */
  creds: EmailCredentialData[];
  /** Today's counts; undefined until every credential's log page has settled. */
  stats: MailStats | undefined;
  logSource: 'clickhouse' | 'memory' | undefined;
}

/**
 * One app's email: the workspace overview (MTA, domains, credentials), the
 * credentials bound to `stack`, and today's sent / delivered from `email.log`
 * filtered by each credential's SMTP username.
 */
export function useAppMail(stack: string): AppMail {
  const trpc = useTRPC();
  const overview = useEmailOverview();
  const creds = React.useMemo(() => (overview.data?.credentials ?? []).filter((c) => c.stack === stack), [overview.data, stack]);
  const logs = useQueries({
    queries: creds.map((c) => ({ ...trpc.email.log.queryOptions({ credential: c.smtpUsername, limit: LOG_LIMIT }), refetchInterval: 15_000 })),
  });
  const settled = logs.every((q) => q.data !== undefined);
  const pages = logs.map((q) => q.data?.items ?? []);
  const stats = overview.data && settled ? mailStats(pages, new Date()) : undefined;
  return { overview, creds, stats, logSource: logs[0]?.data?.source };
}
