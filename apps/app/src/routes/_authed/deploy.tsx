import { createFileRoute } from '@tanstack/react-router';
import { DeployPage } from '@/components/deploy/deploy-page';

export const Route = createFileRoute('/_authed/deploy')({
  component: DeployPage,
});
