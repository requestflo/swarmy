import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { NotificationsPage } from '@/components/notify/notifications-page';

export const Route = createFileRoute('/_authed/settings_/notifications')({
  component: SettingsNotificationsPage,
});

function SettingsNotificationsPage(): React.JSX.Element {
  return <NotificationsPage />;
}
