import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { DataTabPage } from '@/components/stack-data/data-tab-page';

/**
 * Data tab of the app workspace: every managed database, cache, search engine
 * and vector store this app uses, each in a plain sentence, with the
 * "keep it safe if a server fails" choice per Postgres database.
 */
export const Route = createFileRoute('/_authed/stacks/$name/data')({
  component: DataTab,
});

function DataTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <DataTabPage stack={name} />;
}
