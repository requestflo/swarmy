import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackErrorsTab } from '@/components/errors/stack-errors-tab';

/** Errors tab: Sentry-compatible error tracking for this app (DSN + grouped issues). */
export const Route = createFileRoute('/_authed/stacks/$name/errors/')({
  component: ErrorsTab,
});

function ErrorsTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <StackErrorsTab stack={name} />;
}
