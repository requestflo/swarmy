import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { TimeTravelPage } from '@/components/time-travel/time-travel-page';

/**
 * Time travel (board 10): the app over the last 7 days — what ran at any
 * moment, what changed since, and restoring its database to the nearest save.
 * Its own page under the app (Apps / <app> / Time travel), not a tab:
 * reached from Releases › History.
 */
export const Route = createFileRoute('/_authed/stacks/$name_/time-travel')({
  component: TimeTravelRoute,
});

function TimeTravelRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <TimeTravelPage stack={name} />;
}
