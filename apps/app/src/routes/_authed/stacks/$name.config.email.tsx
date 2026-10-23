import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AppEmailTab } from '@/components/app-email/app-email-tab';

/** Config › Email: the app's mail login, today's sent & delivered, and how its mail leaves. */
export const Route = createFileRoute('/_authed/stacks/$name/config/email')({
  component: Page,
});

function Page(): React.JSX.Element {
  const { name } = Route.useParams();
  return <AppEmailTab stack={name} />;
}
