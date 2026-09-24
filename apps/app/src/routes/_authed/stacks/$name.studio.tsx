import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StudioPage } from '@/components/studio/studio-page';

interface StudioSearch {
  /** The database: a managed cluster or compose service name. */
  db?: string;
}

/**
 * Database studio for the app's databases — browse, edit, query, profile.
 * Reached from the Data tab ("Open studio"); every query runs through the
 * agent on the database's server and is audited.
 */
export const Route = createFileRoute('/_authed/stacks/$name/studio')({
  validateSearch: (search: Record<string, unknown>): StudioSearch => (typeof search.db === 'string' && search.db ? { db: search.db } : {}),
  component: StudioTab,
});

function StudioTab(): React.JSX.Element {
  const { name } = Route.useParams();
  const { db } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <StudioPage stack={name} db={db} onDb={(next) => void navigate({ search: { db: next }, replace: true })} />;
}
