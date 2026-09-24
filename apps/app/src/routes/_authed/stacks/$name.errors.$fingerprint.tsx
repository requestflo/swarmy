import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { IssueDetail } from '@/components/errors/issue-detail';

/** One error issue: stack trace, breadcrumbs, tags, linked trace / replay / release, triage. */
export const Route = createFileRoute('/_authed/stacks/$name/errors/$fingerprint')({
  component: IssuePage,
});

function IssuePage(): React.JSX.Element {
  const { name, fingerprint } = Route.useParams();
  return <IssueDetail stack={name} fingerprint={fingerprint} />;
}
