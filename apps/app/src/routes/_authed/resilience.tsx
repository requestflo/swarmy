import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ResiliencePage } from '@/components/resilience/resilience-page';

export const Route = createFileRoute('/_authed/resilience')({
  component: ResilienceRoute,
});

function ResilienceRoute(): React.JSX.Element {
  return <ResiliencePage />;
}
