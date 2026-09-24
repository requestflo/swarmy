import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ReplaysPage } from '@/components/rum/replays-page';

/** Observability → Session replays: the list, playing the newest session. */
export const Route = createFileRoute('/_authed/stacks/$name/replays/')({
  component: ReplaysRoute,
});

function ReplaysRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <ReplaysPage stack={name} />;
}
