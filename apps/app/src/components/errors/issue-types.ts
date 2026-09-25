import type { inferOutput } from '@trpc/tanstack-react-query';
import type { useTRPC } from '@/integrations/trpc';

/** `errors.issue` as the dashboard gets it. */
export type IssueData = inferOutput<ReturnType<typeof useTRPC>['errors']['issue']>;
export type IssueEvent = NonNullable<IssueData['event']>;
