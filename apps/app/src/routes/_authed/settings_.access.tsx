import { createFileRoute } from '@tanstack/react-router';
import { AccessPage } from '@/components/access/access-page';

export const Route = createFileRoute('/_authed/settings_/access')({
  component: AccessPage,
});
