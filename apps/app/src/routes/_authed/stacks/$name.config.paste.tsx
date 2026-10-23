import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { EnvPastePage } from '@/components/env/paste-page/env-paste-page';

interface PasteSearch {
  /** The service to paste into (defaults to the app's first). */
  service?: string;
}

/** Config › Variables & secrets › Paste .env (board EnvPaste): one service, one rolling deploy. */
export const Route = createFileRoute('/_authed/stacks/$name/config/paste')({
  validateSearch: (search: Record<string, unknown>): PasteSearch =>
    typeof search.service === 'string' && search.service ? { service: search.service } : {},
  component: PastePage,
});

function PastePage(): React.JSX.Element {
  const { name } = Route.useParams();
  const { service } = Route.useSearch();
  return <EnvPastePage stack={name} serviceId={service} />;
}
