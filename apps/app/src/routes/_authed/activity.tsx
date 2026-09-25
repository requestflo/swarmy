import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/components/activity/activity-page';

export const Route = createFileRoute('/_authed/activity')({
  component: ActivityPage,
});
