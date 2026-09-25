import { createFileRoute } from '@tanstack/react-router';
import { WorkspacePage } from '@/components/settings/workspace-page';

export const Route = createFileRoute('/_authed/settings')({
  component: WorkspacePage,
});
