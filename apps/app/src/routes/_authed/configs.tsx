import { createFileRoute } from '@tanstack/react-router';
import { ConfigsPage } from '@/components/configsmgr/configs-page';

export const Route = createFileRoute('/_authed/configs')({
  component: ConfigsPage,
});
