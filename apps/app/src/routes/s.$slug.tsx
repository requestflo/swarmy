import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/s/$slug')({
  component: PublicStatusPage,
});

/**
 * Public status page — deliberately OUTSIDE the `_authed` layout: anyone with
 * the link can view it, no session required. The status-pages slice fetches the
 * unauthenticated `GET /status/<slug>.json` snapshot and renders components,
 * uptime bars and incident history here.
 */
function PublicStatusPage(): React.JSX.Element {
  const { slug } = Route.useParams();
  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <span className="eyebrow">Status</span>
        <h1 className="headline mt-3 text-[2.2rem] sm:text-5xl">
          All systems <em>go</em>.
        </h1>
        <p className="text-muted-foreground mt-2 text-sm sm:text-base">
          Live status for <span className="mono-data">{slug}</span> — components, uptime and
          incident history will appear here.
        </p>
      </div>
    </main>
  );
}
