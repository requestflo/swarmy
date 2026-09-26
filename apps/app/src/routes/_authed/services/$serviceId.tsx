import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ServiceSettingsPage } from '@/components/service-settings/service-settings-page';

/** One part of an app, as a calm page: its settings, Logs, and the live compose at Code. */
export const Route = createFileRoute('/_authed/services/$serviceId')({
  component: ServiceDetailPage,
});

function ServiceDetailPage(): React.JSX.Element {
  const { serviceId } = Route.useParams();
  return <ServiceSettingsPage serviceId={serviceId} />;
}
