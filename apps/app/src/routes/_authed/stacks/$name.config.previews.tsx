import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PreviewsTab } from '@/components/gitops/previews/previews-tab';

/** Config › Branch previews: every preview, the rules, the data story, and a new one from any branch. */
export const Route = createFileRoute('/_authed/stacks/$name/config/previews')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <PreviewsTab stack={name} />;
}
