import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PgDetailPage } from '@/components/pgdetail/pg-detail-page';

/** Data › Databases › one Postgres database: its layout, switch-over, connect and extensions. */
export const Route = createFileRoute('/_authed/stacks/$name/data/$cluster')({
  component: PgDetailRoute,
});

function PgDetailRoute(): React.JSX.Element {
  const { name, cluster } = Route.useParams();
  return <PgDetailPage stack={name} cluster={cluster} />;
}
