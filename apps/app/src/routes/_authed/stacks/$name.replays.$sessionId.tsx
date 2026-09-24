import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ReplaysPage } from '@/components/rum/replays-page';

/** One session replay (linked from errors, analytics and the session list). */
export const Route = createFileRoute('/_authed/stacks/$name/replays/$sessionId')({
  component: ReplayRoute,
});

function ReplayRoute(): React.JSX.Element {
  const { name, sessionId } = Route.useParams();
  return <ReplaysPage stack={name} sessionId={sessionId} />;
}
