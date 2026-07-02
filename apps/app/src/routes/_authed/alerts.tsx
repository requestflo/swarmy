import { createFileRoute } from '@tanstack/react-router';
import { AlertsPage } from '@/components/alerts/alerts-page';

export const Route = createFileRoute('/_authed/alerts')({
  component: AlertsPage,
});
