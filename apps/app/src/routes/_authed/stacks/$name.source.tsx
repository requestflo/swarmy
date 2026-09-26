import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SourceTab } from '@/components/stacks/source/source-tab';

/** Source: the spec this app runs from, read-only. Edit it in git. */
export const Route = createFileRoute('/_authed/stacks/$name/source')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <SourceTab stack={name} />;
}
